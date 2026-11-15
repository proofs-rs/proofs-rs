//! Source-only discovery. Never treats the presence of a harness as a successful run.
use crate::config::{CreusotTarget, Project, Tool};
use anyhow::{bail, ensure, Context, Result};
use quote::ToTokens;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use syn::{
    parse::Parser, punctuated::Punctuated, spanned::Spanned, Attribute, Item, Meta, Token, UseTree,
};

#[derive(Clone, Debug)]
pub struct Contract {
    pub spec: Option<CreusotSpec>,
    pub api_paths: Vec<String>,
    pub precondition: String,
    pub file: PathBuf,
    pub first_line: usize,
    pub last_line: usize,
    pub harness: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CreusotSpec {
    pub version: u8,
    pub signature: String,
    pub requires: Vec<String>,
    pub ensures: Vec<String>,
}
struct Function {
    spec: Option<CreusotSpec>,
    path: String,
    module: Vec<String>,
    context: CallableContext,
    name: String,
    public: bool,
    requires: Vec<String>,
    target: Option<syn::ExprPath>,
    annotated: bool,
    excluded: bool,
    file: PathBuf,
    first: usize,
    last: usize,
}
#[derive(Clone)]
enum CallableContext {
    Free,
    Inherent {
        self_ty: syn::Type,
    },
    TraitImpl {
        self_ty: syn::Type,
        trait_path: syn::Path,
        generics: syn::Generics,
    },
}
#[derive(Clone)]
struct Import {
    module: Vec<String>,
    alias: String,
    target: Vec<String>,
    public: bool,
}
struct Scanner<'a> {
    project: &'a Project,
    creusot: bool,
    expanded: bool,
    public_items: BTreeSet<String>,
    traits: BTreeSet<String>,
    self_default_traits: BTreeSet<String>,
    default_methods: std::collections::BTreeMap<String, Vec<(syn::TraitItemFn, PathBuf)>>,
    trait_impls: Vec<(CallableContext, Vec<String>, BTreeSet<String>)>,
    types: BTreeSet<String>,
    functions: Vec<Function>,
    imports: Vec<Import>,
    visited: BTreeSet<PathBuf>,
    ordinary: usize,
}
fn external_trait_paths(path: &str) -> Vec<String> {
    let mut paths = vec![path.to_owned()];
    // Rustdoc's external trait paths in the public catalogue may omit the
    // standard-library module. Do not guess basenames for arbitrary traits.
    if matches!(
        path,
        "core::default::Default"
            | "std::default::Default"
            | "core::clone::Clone"
            | "std::clone::Clone"
            | "core::hash::Hasher"
            | "std::hash::Hasher"
            | "core::fmt::Display"
            | "std::fmt::Display"
            | "core::str::FromStr"
            | "std::str::FromStr"
            | "core::convert::From"
            | "std::convert::From"
            | "core::cmp::Ord"
            | "std::cmp::Ord"
            | "core::cmp::PartialOrd"
            | "std::cmp::PartialOrd"
            | "core::cmp::PartialEq"
            | "std::cmp::PartialEq"
            | "core::iter::Iterator"
            | "std::iter::Iterator"
            | "core::iter::DoubleEndedIterator"
            | "std::iter::DoubleEndedIterator"
    ) {
        paths.push(path.rsplit("::").next().unwrap().to_owned());
    }
    paths
}

fn segments(path: &syn::Path) -> Result<Vec<String>> {
    ensure!(
        path.leading_colon.is_none(),
        "Absolute extern paths are unsupported"
    );
    ensure!(
        path.segments
            .iter()
            .all(|s| matches!(s.arguments, syn::PathArguments::None)),
        "Generic callable paths require compiler-backed resolution"
    );
    Ok(path
        .segments
        .iter()
        .map(|x| x.ident.to_string().trim_start_matches("r#").to_owned())
        .collect())
}
// Rustdoc retains literal/parameter array lengths. Do not guess evaluated
// constants or stringify arbitrary syntax into a potentially different key.
fn render_const(expr: &syn::Expr) -> Result<String> {
    match expr {
        syn::Expr::Lit(l) => Ok(l.to_token_stream().to_string()),
        syn::Expr::Path(p) if p.qself.is_none() => Ok(segments(&p.path)?.join("::")),
        _ => bail!("Const expressions require compiler-backed resolution"),
    }
}
impl CallableContext {
    fn path(&self, scanner: &Scanner<'_>, module: &[String], name: &str) -> Result<String> {
        match self {
            Self::Free => Ok(item_path(module, name)),
            Self::Inherent { self_ty } => Ok(format!(
                "{}::{name}",
                scanner
                    .nominal_type(self_ty, module)?
                    .context("Unsupported inherent self type")?
            )),
            Self::TraitImpl {
                self_ty,
                trait_path,
                generics,
            } => Ok(format!(
                "<{} as {}>::{name}",
                scanner.render_type(self_ty, module, generics)?,
                scanner.render_path(trait_path, module, generics)?
            )),
        }
    }
    fn self_ty(&self) -> Option<&syn::Type> {
        match self {
            Self::Free => None,
            Self::Inherent { self_ty } | Self::TraitImpl { self_ty, .. } => Some(self_ty),
        }
    }
}
fn list(meta: &syn::MetaList) -> Result<Punctuated<Meta, Token![,]>> {
    Ok(Punctuated::parse_terminated.parse2(meta.tokens.clone())?)
}
fn predicate(meta: &Meta, p: &Project) -> Result<bool> {
    match meta {
        Meta::Path(path) => {
            let name = path.to_token_stream().to_string();
            ensure!(
                matches!(
                    name.as_str(),
                    "kani"
                        | "creusot"
                        | "aeneas"
                        | "test"
                        | "doc"
                        | "docsrs"
                        | "unix"
                        | "windows"
                        | "debug_assertions"
                        | "proc_macro"
                ) || p.cfg.contains(&name),
                "Unsupported cfg({name}); cannot safely select verification sources"
            );
            Ok(p.cfg.contains(&name))
        }
        Meta::NameValue(nv) => {
            let key = nv.path.to_token_stream().to_string();
            let syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(value),
                ..
            }) = &nv.value
            else {
                bail!("Unsupported cfg value");
            };
            if key == "feature" {
                return Ok(p.features.contains(&value.value()));
            }
            ensure!(
                key.starts_with("target_") || key == "panic",
                "Unsupported cfg key {key}"
            );
            Ok(p.cfg.contains(&format!("{}={:?}", key, value.value())))
        }
        Meta::List(l) => {
            let ps: Vec<bool> = list(l)?
                .iter()
                .map(|m| predicate(m, p))
                .collect::<Result<_>>()?;
            if l.path.is_ident("all") {
                Ok(ps.iter().all(|b| *b))
            } else if l.path.is_ident("any") {
                Ok(ps.iter().any(|b| *b))
            } else if l.path.is_ident("not") && ps.len() == 1 {
                Ok(!ps[0])
            } else {
                bail!("Unsupported cfg predicate")
            }
        }
    }
}
fn expand(meta: &Meta, p: &Project, out: &mut Vec<Meta>) -> Result<()> {
    if let Meta::List(l) = meta {
        if l.path.is_ident("cfg_attr") {
            let args = list(l)?;
            let mut iter = args.iter();
            if predicate(iter.next().context("Empty cfg_attr")?, p)? {
                for m in iter {
                    expand(m, p, out)?;
                }
            }
            return Ok(());
        }
    }
    out.push(meta.clone());
    Ok(())
}
fn attrs(attrs: &[Attribute], p: &Project) -> Result<Option<Vec<Meta>>> {
    let mut out = vec![];
    for a in attrs {
        expand(&a.meta, p, &mut out)?;
    }
    for m in &out {
        if let Meta::List(l) = m {
            if l.path.is_ident("cfg") && !predicate(&syn::parse2(l.tokens.clone())?, p)? {
                return Ok(None);
            }
        }
    }
    Ok(Some(out))
}
fn kani(meta: &Meta, name: &str) -> bool {
    let p = meta.path();
    p.segments.len() == 2 && p.segments[0].ident == "kani" && p.segments[1].ident == name
}
fn creusot(meta: &Meta, name: &str) -> bool {
    let p = meta.path();
    p.is_ident(name)
        || (p.segments.len() == 2
            && matches!(
                p.segments[0].ident.to_string().as_str(),
                "creusot_std" | "creusot_contracts"
            )
            && p.segments[1].ident == name)
}

fn item_path(module: &[String], name: &str) -> String {
    module
        .iter()
        .map(String::as_str)
        .chain([name])
        .collect::<Vec<_>>()
        .join("::")
}

fn source_text(file: &Path, span: proc_macro2::Span) -> Result<String> {
    let source = fs::read_to_string(file)?;
    let offset = |location: proc_macro2::LineColumn| -> Result<usize> {
        let line = source
            .split_inclusive('\n')
            .take(location.line - 1)
            .map(str::len)
            .sum::<usize>();
        // proc_macro2 columns count Unicode characters, not UTF-8 bytes.
        let column = source[line..]
            .chars()
            .take(location.column)
            .map(char::len_utf8)
            .sum::<usize>();
        Ok(line + column)
    };
    Ok(source
        .get(offset(span.start())?..offset(span.end())?)
        .context("Cannot locate Creusot contract in source")?
        .to_owned())
}

/// Discard function bodies before syn parses them: logic bodies may use Pearlite.
/// Attribute and macro token streams are otherwise retained, with original spans.
fn declarations(tokens: proc_macro2::TokenStream) -> proc_macro2::TokenStream {
    use proc_macro2::{Group, TokenTree};
    let mut function = false;
    let mut angles = 0usize;
    let tokens: Vec<_> = tokens.into_iter().collect();
    tokens
        .iter()
        .enumerate()
        .map(|(index, token)| {
            match token {
                TokenTree::Ident(i)
                    if i == "fn" && matches!(tokens.get(index + 1), Some(TokenTree::Ident(_))) =>
                {
                    function = true
                }
                TokenTree::Punct(p) if function && p.as_char() == '<' => angles += 1,
                TokenTree::Punct(p) if function && p.as_char() == '>' => {
                    angles = angles.saturating_sub(1)
                }
                TokenTree::Punct(p) if p.as_char() == ';' => {
                    function = false;
                    angles = 0;
                }
                TokenTree::Group(g) if g.delimiter() == proc_macro2::Delimiter::Brace => {
                    let stream = if function && angles == 0 {
                        function = false;
                        proc_macro2::TokenStream::new()
                    } else {
                        declarations(g.stream())
                    };
                    let mut replacement = Group::new(g.delimiter(), stream);
                    replacement.set_span(g.span());
                    return TokenTree::Group(replacement);
                }
                _ => {}
            }
            token.clone()
        })
        .collect()
}

pub fn discover_for_tool(project: &Project, tool: &Tool) -> Result<Vec<Contract>> {
    if tool.is_aeneas() {
        return crate::aeneas::discover(project, tool);
    }
    if !tool.is_creusot() {
        return discover(project);
    }
    public_contracts(
        project,
        true,
        tool.target.context("Creusot requires [tool].target")?,
    )
}

pub(crate) fn public_contracts(
    project: &Project,
    creusot: bool,
    target: CreusotTarget,
) -> Result<Vec<Contract>> {
    public_contracts_from(project, creusot, target, &project.root_source, false)
}

pub(crate) fn expanded_public_contracts(project: &Project, source: &Path) -> Result<Vec<Contract>> {
    public_contracts_from(project, false, CreusotTarget::All, source, true)
}

fn public_contracts_from(
    project: &Project,
    creusot: bool,
    target: CreusotTarget,
    source: &Path,
    expanded: bool,
) -> Result<Vec<Contract>> {
    let mut s = scanner(project, creusot);
    s.expanded = expanded;
    s.file(source, &[], true)?;
    if expanded {
        // Enumerate inherited defaults only from locally observed active traits.
        // Explicit implementations replace defaults; external trait bodies are unknown.
        for (context, module, overrides) in s.trait_impls.clone() {
            let CallableContext::TraitImpl { trait_path, .. } = &context else {
                continue;
            };
            let resolved = s.resolve(
                &trait_path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>(),
                &module,
                0,
            )?;
            for (method, file) in s
                .default_methods
                .get(&resolved)
                .cloned()
                .unwrap_or_default()
            {
                if !overrides.contains(&method.sig.ident.to_string()) {
                    s.function(
                        &method.attrs,
                        &method.sig,
                        &syn::Visibility::Inherited,
                        method.span(),
                        &file,
                        &module,
                        context.clone(),
                    )?;
                }
            }
        }
    }
    let mut result = vec![];
    let mut seen = BTreeSet::new();
    for f in &s.functions {
        if !f.public || f.excluded || (target == CreusotTarget::Annotated && !f.annotated) {
            continue;
        }
        let path = f.context.path(&s, &f.module, &f.name)?;
        let paths = s.public_callable_paths(&f.context, &f.module, &f.name)?;
        if paths.is_empty() {
            continue;
        }
        ensure!(
            seen.insert(path.clone()),
            "Ambiguous contract target {path}"
        );
        result.push(Contract {
            spec: f.spec.clone(),
            api_paths: paths,
            precondition: if f.requires.is_empty() {
                "true".into()
            } else {
                f.requires
                    .iter()
                    .map(|r| format!("({r})"))
                    .collect::<Vec<_>>()
                    .join(" && ")
            },
            file: f.file.clone(),
            first_line: f.first,
            last_line: f.last,
            harness: path,
        });
    }
    ensure!(
        !result.is_empty(),
        "No eligible public APIs found in the selected library/configuration"
    );
    result.sort_by(|a, b| a.api_paths.cmp(&b.api_paths));
    Ok(result)
}

impl Scanner<'_> {
    fn nominal_type(&self, ty: &syn::Type, module: &[String]) -> Result<Option<String>> {
        let syn::Type::Path(ty) = ty else {
            return Ok(None);
        };
        if ty.qself.is_some() {
            return Ok(None);
        }
        let mut path = ty.path.clone();
        for s in &mut path.segments {
            s.arguments = syn::PathArguments::None;
        }
        Ok(Some(self.resolve(&segments(&path)?, module, 0)?))
    }
    fn render_type(
        &self,
        value: &syn::Type,
        module: &[String],
        generics: &syn::Generics,
    ) -> Result<String> {
        self.render_type_in(value, module, generics, false)
    }
    fn render_path(
        &self,
        value: &syn::Path,
        module: &[String],
        generics: &syn::Generics,
    ) -> Result<String> {
        self.render_path_in(value, module, generics, false)
    }

    fn render_path_in(
        &self,
        path: &syn::Path,
        module: &[String],
        generics: &syn::Generics,
        public_paths: bool,
    ) -> Result<String> {
        let mut bare = path.clone();
        bare.leading_colon = None;
        for s in &mut bare.segments {
            s.arguments = syn::PathArguments::None;
        }
        let parts = segments(&bare)?;
        let resolved = self.resolve(&parts, module, 0)?;
        let local = self.types.contains(&resolved) || self.traits.contains(&resolved);
        let primitive = parts.len() == 1
            && matches!(
                parts[0].as_str(),
                "bool"
                    | "char"
                    | "str"
                    | "u8"
                    | "u16"
                    | "u32"
                    | "u64"
                    | "u128"
                    | "usize"
                    | "i8"
                    | "i16"
                    | "i32"
                    | "i64"
                    | "i128"
                    | "isize"
                    | "f32"
                    | "f64"
            );
        let generic = parts.len() == 1
            && generics.params.iter().any(|p| match p {
                syn::GenericParam::Type(t) => t.ident == parts[0],
                syn::GenericParam::Const(c) => c.ident == parts[0],
                _ => false,
            });
        let mut name = if generic || primitive {
            parts[0].clone()
        } else if local {
            let name = if public_paths {
                self.creusot_public_paths(&resolved)?
                    .into_iter()
                    .next()
                    .with_context(|| format!("Type {resolved} has no public API path"))?
            } else {
                resolved
            };
            format!("{}::{name}", self.project.lib_name)
        } else {
            // Imports are resolved before recognizing prelude names. Never
            // strip arbitrary external modules down to a basename.
            let prefix = module.join("::") + "::";
            resolved
                .strip_prefix(&prefix)
                .unwrap_or(&resolved)
                .to_owned()
        };
        if !generic {
            name = match name.as_str() {
                "Vec" | "std::vec::Vec" => "alloc::vec::Vec".into(),
                "String" | "std::string::String" => "alloc::string::String".into(),
                "Box" | "std::boxed::Box" => "alloc::boxed::Box".into(),
                "Option" | "std::option::Option" => "core::option::Option".into(),
                "Result" | "std::result::Result" => "core::result::Result".into(),
                "std::net::Ipv4Addr" | "core::net::Ipv4Addr" if self.expanded => {
                    "core::net::ip_addr::Ipv4Addr".into()
                }
                "std::net::Ipv6Addr" | "core::net::Ipv6Addr" if self.expanded => {
                    "core::net::ip_addr::Ipv6Addr".into()
                }
                "std::net::IpAddr" | "core::net::IpAddr" if self.expanded => {
                    "core::net::ip_addr::IpAddr".into()
                }
                _ => name,
            };
        }
        ensure!(
            path.segments
                .iter()
                .rev()
                .skip(1)
                .all(|s| matches!(s.arguments, syn::PathArguments::None)),
            "Generic intermediate paths require compiler-backed resolution"
        );
        name.push_str(&self.render_arguments_in(
            &path.segments.last().context("Empty type path")?.arguments,
            module,
            generics,
            public_paths,
        )?);
        Ok(name)
    }
    fn render_arguments_in(
        &self,
        args: &syn::PathArguments,
        module: &[String],
        generics: &syn::Generics,
        public_paths: bool,
    ) -> Result<String> {
        match args {
            syn::PathArguments::None => Ok(String::new()),
            syn::PathArguments::AngleBracketed(a) => {
                let values = a
                    .args
                    .iter()
                    .map(|arg| {
                        Ok(match arg {
                            syn::GenericArgument::Type(t) => {
                                self.render_type_in(t, module, generics, public_paths)?
                            }
                            syn::GenericArgument::Lifetime(l) => l.to_string(),
                            syn::GenericArgument::Const(c) => render_const(c)?,
                            syn::GenericArgument::AssocType(a) => format!(
                                "{} = {}",
                                a.ident,
                                self.render_type_in(&a.ty, module, generics, public_paths)?
                            ),
                            syn::GenericArgument::AssocConst(a) => {
                                format!("{} = {}", a.ident, render_const(&a.value)?)
                            }
                            _ => bail!(
                                "Unsupported generic argument; compiler-backed resolution required"
                            ),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(if values.is_empty() {
                    String::new()
                } else {
                    format!("<{}>", values.join(", "))
                })
            }
            syn::PathArguments::Parenthesized(a) => {
                let inputs = a
                    .inputs
                    .iter()
                    .map(|t| self.render_type_in(t, module, generics, public_paths))
                    .collect::<Result<Vec<_>>>()?;
                Ok(format!(
                    "({}){}",
                    inputs.join(", "),
                    self.render_return_in(&a.output, module, generics, public_paths)?
                ))
            }
        }
    }
    fn render_return_in(
        &self,
        out: &syn::ReturnType,
        module: &[String],
        generics: &syn::Generics,
        public_paths: bool,
    ) -> Result<String> {
        match out {
            syn::ReturnType::Default => Ok(String::new()),
            syn::ReturnType::Type(_, t) => Ok(format!(
                " -> {}",
                self.render_type_in(t, module, generics, public_paths)?
            )),
        }
    }
    fn render_type_in(
        &self,
        ty: &syn::Type,
        module: &[String],
        generics: &syn::Generics,
        public_paths: bool,
    ) -> Result<String> {
        Ok(match ty {
            syn::Type::Path(t) if t.qself.is_none() => {
                self.render_path_in(&t.path, module, generics, public_paths)?
            }
            syn::Type::Array(t) => format!(
                "[{}; {}]",
                self.render_type_in(&t.elem, module, generics, public_paths)?,
                render_const(&t.len)?
            ),
            syn::Type::Slice(t) => format!(
                "[{}]",
                self.render_type_in(&t.elem, module, generics, public_paths)?
            ),
            syn::Type::Tuple(t) => {
                let elements = t
                    .elems
                    .iter()
                    .map(|t| self.render_type_in(t, module, generics, public_paths))
                    .collect::<Result<Vec<_>>>()?;
                format!(
                    "({}{})",
                    elements.join(", "),
                    if elements.len() == 1 { "," } else { "" }
                )
            }
            syn::Type::Reference(t) => format!(
                "&{}{}{}",
                t.lifetime
                    .as_ref()
                    .map(|l| format!("{l} "))
                    .unwrap_or_default(),
                if t.mutability.is_some() { "mut " } else { "" },
                self.render_type_in(&t.elem, module, generics, public_paths)?
            ),
            syn::Type::Ptr(t) => format!(
                "*{} {}",
                if t.mutability.is_some() {
                    "mut"
                } else {
                    "const"
                },
                self.render_type_in(&t.elem, module, generics, public_paths)?
            ),
            syn::Type::Paren(t) => self.render_type_in(&t.elem, module, generics, public_paths)?,
            syn::Type::Group(t) => self.render_type_in(&t.elem, module, generics, public_paths)?,
            syn::Type::Never(_) => "!".into(),
            syn::Type::Infer(_) => "_".into(),
            _ => bail!("Unsupported self type; compiler-backed resolution required"),
        })
    }

    fn public_callable_paths(
        &self,
        context: &CallableContext,
        module: &[String],
        name: &str,
    ) -> Result<Vec<String>> {
        match context {
            CallableContext::Free => self.creusot_public_paths(&item_path(module, name)),
            CallableContext::Inherent { self_ty } => {
                let ty = self
                    .nominal_type(self_ty, module)?
                    .context("Unsupported inherent self type")?;
                self.creusot_public_paths(&format!("{ty}::{name}"))
            }
            CallableContext::TraitImpl {
                self_ty,
                trait_path,
                generics,
            } => {
                let mut bare_trait = trait_path.clone();
                for segment in &mut bare_trait.segments {
                    segment.arguments = syn::PathArguments::None;
                }
                let tr = self.resolve(&segments(&bare_trait)?, module, 0)?;
                let nominal = self.nominal_type(self_ty, module)?;
                let legacy = nominal.as_ref().is_some_and(|ty| self.types.contains(ty));
                let types = if legacy {
                    self.creusot_public_paths(nominal.as_ref().unwrap())?
                        .into_iter()
                        .map(|ty| format!("{}::{ty}", self.project.lib_name))
                        .collect()
                } else {
                    vec![self.render_type_in(self_ty, module, generics, true)?]
                };
                let local_trait = self.traits.contains(&tr);
                if !legacy && !local_trait {
                    return Ok(vec![]);
                }
                let suffix = self.render_arguments_in(
                    &trait_path.segments.last().unwrap().arguments,
                    module,
                    generics,
                    !legacy,
                )?;
                let mut suffixes = vec![suffix];
                // Rustdoc's type-driven catalogue preserves written simple type
                // arguments, while structural self types use canonical paths.
                if self.expanded && legacy {
                    let args = &trait_path.segments.last().unwrap().arguments;
                    if let syn::PathArguments::AngleBracketed(a) = args {
                        if a.args.iter().all(|arg| matches!(arg, syn::GenericArgument::Type(syn::Type::Path(p)) if p.qself.is_none() && p.path.segments.iter().all(|s| matches!(s.arguments, syn::PathArguments::None)))) {
                            let written = args.to_token_stream().to_string().chars().filter(|c| !c.is_whitespace()).collect::<String>();
                            if !suffixes.contains(&written) { suffixes.push(written); }
                        }
                    }
                }
                if self.expanded && local_trait && self.self_default_traits.contains(&tr) {
                    if let syn::PathArguments::AngleBracketed(args) =
                        &trait_path.segments.last().unwrap().arguments
                    {
                        if args.args.len() == 1 {
                            if let Some(syn::GenericArgument::Type(rhs)) = args.args.first() {
                                if self.render_type_in(rhs, module, generics, true)?
                                    == self.render_type_in(self_ty, module, generics, true)?
                                {
                                    suffixes.push(String::new());
                                }
                            }
                        }
                    }
                }
                let traits = if local_trait {
                    self.creusot_public_paths(&tr)?
                } else {
                    // Use the same resolved external path as the harness. resolve()
                    // can retain a private module prefix for imported extern paths.
                    external_trait_paths(&self.render_path(&bare_trait, module, generics)?)
                };
                let mut paths = BTreeSet::new();
                for ty in &types {
                    for tr in &traits {
                        let tr = if local_trait {
                            format!("{}::{tr}", self.project.lib_name)
                        } else {
                            tr.clone()
                        };
                        for suffix in &suffixes {
                            paths.insert(format!("<{ty} as {tr}{suffix}>::{name}"));
                        }
                    }
                }
                Ok(paths.into_iter().collect())
            }
        }
    }
    fn creusot_attr(&self, meta: &Meta, name: &str, module: &[String]) -> Result<bool> {
        if creusot(meta, name) {
            return Ok(true);
        }
        let path = self.resolve(&segments(meta.path())?, module, 0)?;
        // Module-local imports of an external crate acquire the local module prefix
        // in the source resolver. Match the external crate and known macro modules.
        let parts: Vec<_> = path.split("::").collect();
        Ok(parts.iter().enumerate().any(|(n, p)| {
            matches!(*p, "creusot_std" | "creusot_contracts")
                && (parts[n + 1..] == [name]
                    || parts[n + 1..] == ["macros", name]
                    || parts[n + 1..] == ["prelude", name])
        }))
    }
    fn creusot_public_paths(&self, path: &str) -> Result<Vec<String>> {
        if (self.types.contains(path) || self.traits.contains(path))
            && !self.public_items.contains(path)
        {
            return Ok(vec![]);
        }
        // Every intermediate module/type must be public, unless explicitly reexported.
        let traversable = |path: &str, from: usize| {
            let parts: Vec<_> = path.split("::").collect();
            (from..parts.len()).all(|n| self.public_items.contains(&parts[..n].join("::")))
        };
        let mut paths = BTreeSet::new();
        if traversable(path, 1) {
            paths.insert(path.to_owned());
        }
        for import in self.imports.iter().filter(|i| i.public) {
            if !traversable(&item_path(&import.module, &import.alias), 1) {
                continue;
            }
            let source = self.resolve(&import.target, &import.module, 0)?;
            if path == source
                || (path.starts_with(&(source.clone() + "::"))
                    && traversable(path, source.split("::").count()))
            {
                paths.insert(format!(
                    "{}{}",
                    item_path(&import.module, &import.alias),
                    &path[source.len()..]
                ));
            }
        }
        Ok(paths.into_iter().collect())
    }
    fn file(&mut self, file: &Path, module: &[String], public: bool) -> Result<()> {
        let file = file
            .canonicalize()
            .with_context(|| format!("Read module {}", file.display()))?;
        ensure!(
            self.visited.insert(file.clone()),
            "Module included more than once: {}",
            file.display()
        );
        let source = fs::read_to_string(&file)?;
        // Pearlite bodies need not be valid Rust. Only declarations are relevant.
        let mut parsed = if self.creusot {
            syn::parse2(declarations(syn::parse_str(&source)?))
        } else {
            syn::parse_file(&source)
        }
        .with_context(|| format!("Parse {}", file.display()))?;
        if attrs(&parsed.attrs, self.project)?.is_none() {
            return Ok(());
        }
        let module_dir = if module.is_empty() || file.file_name().is_some_and(|n| n == "mod.rs") {
            file.parent().unwrap().to_owned()
        } else {
            file.parent().unwrap().join(file.file_stem().unwrap())
        };
        if self.expanded {
            // Compiler expansion emits absolute extern paths and an injected
            // prelude glob. Normalize those only for compiler-produced input.
            struct Normalize;
            impl syn::visit_mut::VisitMut for Normalize {
                fn visit_path_mut(&mut self, path: &mut syn::Path) {
                    path.leading_colon = None;
                    syn::visit_mut::visit_path_mut(self, path);
                }
                fn visit_item_mod_mut(&mut self, item: &mut syn::ItemMod) {
                    if let Some((_, items)) = &mut item.content {
                        items.retain(|i| !matches!(i, Item::Use(u) if u.attrs.iter().any(|a| a.path().is_ident("prelude_import"))));
                    }
                    syn::visit_mut::visit_item_mod_mut(self, item);
                }
            }
            parsed.items.retain(|i| !matches!(i, Item::Use(u) if u.attrs.iter().any(|a| a.path().is_ident("prelude_import"))));
            syn::visit_mut::VisitMut::visit_file_mut(&mut Normalize, &mut parsed);
        }
        self.items(&parsed.items, &file, &module_dir, module, public)
    }
    fn items(
        &mut self,
        items: &[Item],
        file: &Path,
        module_dir: &Path,
        module: &[String],
        public: bool,
    ) -> Result<()> {
        // Imports are in scope regardless of their source order.
        for item in items {
            if let Item::Use(u) = item {
                if attrs(&u.attrs, self.project)?.is_some() {
                    self.use_tree(
                        &u.tree,
                        vec![],
                        module,
                        matches!(u.vis, syn::Visibility::Public(_)),
                    )?;
                }
            }
        }
        for item in items {
            match item {
                Item::Mod(m) => {
                    let Some(ms) = attrs(&m.attrs, self.project)? else {
                        continue;
                    };
                    if matches!(m.vis, syn::Visibility::Public(_)) {
                        self.public_items
                            .insert(item_path(module, &m.ident.to_string()));
                    }
                    let mut child = module.to_vec();
                    child.push(m.ident.to_string());
                    let pub_child = public && matches!(m.vis, syn::Visibility::Public(_));
                    if let Some((_, items)) = &m.content {
                        self.items(
                            items,
                            file,
                            &module_dir.join(m.ident.to_string()),
                            &child,
                            pub_child,
                        )?;
                    } else {
                        let explicit = ms.iter().find_map(|m| match m {
                            Meta::NameValue(v) if v.path.is_ident("path") => match &v.value {
                                syn::Expr::Lit(syn::ExprLit {
                                    lit: syn::Lit::Str(s),
                                    ..
                                }) => Some(s.value()),
                                _ => None,
                            },
                            _ => None,
                        });
                        let path = if let Some(path) = explicit {
                            module_dir.join(path)
                        } else {
                            let a = module_dir.join(format!("{}.rs", m.ident));
                            let b = module_dir.join(m.ident.to_string()).join("mod.rs");
                            ensure!(!(a.exists() && b.exists()), "Ambiguous module {}", m.ident);
                            if a.exists() {
                                a
                            } else {
                                b
                            }
                        };
                        self.file(&path, &child, pub_child)?;
                    }
                }
                Item::Struct(i) => {
                    if attrs(&i.attrs, self.project)?.is_some() {
                        self.types.insert(item_path(module, &i.ident.to_string()));
                    }
                    if matches!(i.vis, syn::Visibility::Public(_))
                        && attrs(&i.attrs, self.project)?.is_some()
                    {
                        self.public_items
                            .insert(item_path(module, &i.ident.to_string()));
                    }
                }
                Item::Enum(i) => {
                    if attrs(&i.attrs, self.project)?.is_some() {
                        self.types.insert(item_path(module, &i.ident.to_string()));
                    }
                    if matches!(i.vis, syn::Visibility::Public(_))
                        && attrs(&i.attrs, self.project)?.is_some()
                    {
                        self.public_items
                            .insert(item_path(module, &i.ident.to_string()));
                    }
                }
                Item::Union(i) => {
                    if attrs(&i.attrs, self.project)?.is_some() {
                        self.types.insert(item_path(module, &i.ident.to_string()));
                    }
                    if matches!(i.vis, syn::Visibility::Public(_))
                        && attrs(&i.attrs, self.project)?.is_some()
                    {
                        self.public_items
                            .insert(item_path(module, &i.ident.to_string()));
                    }
                }
                Item::Trait(i) => {
                    if attrs(&i.attrs, self.project)?.is_some() {
                        let path = item_path(module, &i.ident.to_string());
                        self.traits.insert(path.clone());
                        if self.expanded {
                            let methods = i
                                .items
                                .iter()
                                .filter_map(|item| match item {
                                    syn::TraitItem::Fn(f) if f.default.is_some() => {
                                        Some((f.clone(), file.to_owned()))
                                    }
                                    _ => None,
                                })
                                .collect();
                            self.default_methods.insert(path.clone(), methods);
                        }
                        if i.generics.params.len() == 1
                            && matches!(i.generics.params.first(), Some(syn::GenericParam::Type(p)) if matches!(&p.default, Some(syn::Type::Path(t)) if t.qself.is_none() && t.path.is_ident("Self")))
                        {
                            self.self_default_traits.insert(path.clone());
                        }

                        if matches!(i.vis, syn::Visibility::Public(_)) {
                            self.public_items.insert(path);
                        }
                    }
                }
                Item::Fn(f) => self.function(
                    &f.attrs,
                    &f.sig,
                    &f.vis,
                    f.span(),
                    file,
                    module,
                    CallableContext::Free,
                )?,
                Item::Impl(i) => {
                    if attrs(&i.attrs, self.project)?.is_none() {
                        continue;
                    }
                    let context = if let Some((negative, trait_path, _)) = &i.trait_ {
                        if negative.is_some() {
                            continue;
                        }
                        CallableContext::TraitImpl {
                            self_ty: (*i.self_ty).clone(),
                            trait_path: trait_path.clone(),
                            generics: i.generics.clone(),
                        }
                    } else {
                        let syn::Type::Path(owner) = &*i.self_ty else {
                            continue;
                        };
                        if owner.qself.is_some() || segments(&owner.path).is_err() {
                            continue;
                        }
                        CallableContext::Inherent {
                            self_ty: (*i.self_ty).clone(),
                        }
                    };
                    if self.expanded && matches!(context, CallableContext::TraitImpl { .. }) {
                        self.trait_impls.push((
                            context.clone(),
                            module.to_vec(),
                            i.items
                                .iter()
                                .filter_map(|item| match item {
                                    syn::ImplItem::Fn(f) => Some(f.sig.ident.to_string()),
                                    _ => None,
                                })
                                .collect(),
                        ));
                    }
                    for method in &i.items {
                        if let syn::ImplItem::Fn(f) = method {
                            self.function(
                                &f.attrs,
                                &f.sig,
                                &f.vis,
                                f.span(),
                                file,
                                module,
                                context.clone(),
                            )?;
                        }
                    }
                }
                Item::Use(_) => {}
                Item::Macro(m) => {
                    let active_include =
                        m.mac.path.is_ident("include") && attrs(&m.attrs, self.project)?.is_some();
                    ensure!(
                        !active_include,
                        "include! sources are unsupported: {}",
                        file.display()
                    );
                }
                _ => {}
            }
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    fn function(
        &mut self,
        attributes: &[Attribute],
        sig: &syn::Signature,
        vis: &syn::Visibility,
        span: proc_macro2::Span,
        file: &Path,
        module: &[String],
        context: CallableContext,
    ) -> Result<()> {
        let Some(ms) = attrs(attributes, self.project)? else {
            return Ok(());
        };
        let mut requires = vec![];
        let mut ensures = vec![];
        let mut annotated = false;
        let mut excluded = false;
        let mut target = None;
        for m in &ms {
            if self.creusot {
                if self.creusot_attr(m, "requires", module)?
                    || self.creusot_attr(m, "ensures", module)?
                {
                    annotated = true;
                }
                for name in ["trusted", "logic", "predicate", "law"] {
                    excluded |= self.creusot_attr(m, name, module)?;
                }
                if self.creusot_attr(m, "check", module)? {
                    if let Meta::List(l) = m {
                        excluded |=
                            l.tokens.clone().into_iter().any(
                                |t| matches!(t, proc_macro2::TokenTree::Ident(i) if i == "ghost"),
                            );
                    }
                }
                let is_requires = self.creusot_attr(m, "requires", module)?;
                if is_requires || self.creusot_attr(m, "ensures", module)? {
                    let Meta::List(l) = m else {
                        bail!("Invalid Creusot specification attribute");
                    };
                    ensure!(
                        !l.tokens.is_empty(),
                        "Empty Creusot specification attribute"
                    );
                    let text = source_text(file, l.delimiter.span().join())?;
                    let expression = text[1..text.len() - 1].to_owned();
                    if is_requires {
                        requires.push(expression);
                    } else {
                        ensures.push(expression);
                    }
                }
                continue;
            }
            if kani(m, "proof") {
                self.ordinary += 1;
            }
            if kani(m, "requires") {
                let Meta::List(l) = m else {
                    bail!("Invalid requires attribute");
                };
                let expression: syn::Expr = syn::parse2(l.tokens.clone())?;
                requires.push(expression.to_token_stream().to_string());
            }
            if kani(m, "proof_for_contract") {
                ensure!(target.is_none(), "Duplicate proof_for_contract attribute");
                let Meta::List(l) = m else {
                    bail!("Invalid proof_for_contract attribute");
                };
                target = Some(
                    syn::parse2::<syn::ExprPath>(l.tokens.clone())
                        .context("Unsupported contract target path")?,
                );
            }
        }
        let name = sig.ident.to_string().trim_start_matches("r#").to_owned();
        let path = module
            .iter()
            .chain(std::iter::once(&name))
            .cloned()
            .collect::<Vec<_>>()
            .join("::");
        self.functions.push(Function {
            spec: if self.creusot {
                let signature_span = if matches!(vis, syn::Visibility::Public(_)) {
                    vis.span()
                        .join(sig.span())
                        .context("Cannot locate function signature")?
                } else {
                    sig.span()
                };
                Some(CreusotSpec {
                    version: 1,
                    signature: source_text(file, signature_span)?,
                    requires: requires.clone(),
                    ensures,
                })
            } else {
                None
            },
            path,
            name,
            module: module.to_vec(),
            public: matches!(context, CallableContext::TraitImpl { .. })
                || matches!(vis, syn::Visibility::Public(_)),
            context,
            requires,
            target,
            annotated,
            excluded,
            file: file.into(),
            first: attributes
                .first()
                .map_or(span.start().line, |a| a.span().start().line),
            last: span.end().line,
        });
        Ok(())
    }
    fn use_tree(
        &mut self,
        tree: &UseTree,
        mut prefix: Vec<String>,
        module: &[String],
        public: bool,
    ) -> Result<()> {
        match tree {
            UseTree::Path(p) => {
                prefix.push(p.ident.to_string());
                self.use_tree(&p.tree, prefix, module, public)?;
            }
            UseTree::Name(n) => {
                let alias = if n.ident == "self" {
                    prefix.last().context("Invalid use self")?.clone()
                } else {
                    prefix.push(n.ident.to_string());
                    n.ident.to_string()
                };
                self.imports.push(Import {
                    module: module.to_vec(),
                    alias,
                    target: prefix,
                    public,
                });
            }
            UseTree::Rename(r) => {
                if r.ident != "self" {
                    prefix.push(r.ident.to_string());
                }
                self.imports.push(Import {
                    module: module.to_vec(),
                    alias: r.rename.to_string(),
                    target: prefix,
                    public,
                });
            }
            UseTree::Group(g) => {
                for t in &g.items {
                    self.use_tree(t, prefix.clone(), module, public)?;
                }
            }
            UseTree::Glob(_) => {} // Never guess a target through a glob import.
        }
        Ok(())
    }
    fn resolve(&self, parts: &[String], module: &[String], depth: usize) -> Result<String> {
        ensure!(depth < 32, "Cyclic or excessively nested import aliases");
        ensure!(!parts.is_empty(), "Empty target path");
        let mut base = module.to_vec();
        let mut rest = parts;
        if parts[0] == "crate" || parts[0] == self.project.lib_name {
            base.clear();
            rest = &parts[1..];
        } else if parts[0] == "self" {
            rest = &parts[1..];
        } else if parts[0] == "super" {
            while rest.first().is_some_and(|x| x == "super") {
                ensure!(base.pop().is_some(), "super escapes crate root");
                rest = &rest[1..];
            }
        }
        if let Some(first) = rest.first() {
            let aliases: Vec<_> = self
                .imports
                .iter()
                .filter(|i| i.module == base && i.alias == *first)
                .collect();
            ensure!(aliases.len() <= 1, "Ambiguous import {first}");
            if let Some(i) = aliases.first() {
                let target = self.resolve(&i.target, &i.module, depth + 1)?;
                return Ok(std::iter::once(target)
                    .chain(rest[1..].iter().cloned())
                    .collect::<Vec<_>>()
                    .join("::"));
            }
        }
        base.extend_from_slice(rest);
        Ok(base.join("::"))
    }
}
fn scanner(project: &Project, creusot: bool) -> Scanner<'_> {
    Scanner {
        project,
        creusot,
        expanded: false,
        public_items: BTreeSet::new(),
        traits: BTreeSet::new(),
        self_default_traits: BTreeSet::new(),
        default_methods: Default::default(),
        trait_impls: vec![],
        types: BTreeSet::new(),
        functions: vec![],
        imports: vec![],
        visited: BTreeSet::new(),
        ordinary: 0,
    }
}
pub fn discover(project: &Project) -> Result<Vec<Contract>> {
    let mut s = scanner(project, false);
    s.file(&project.root_source, &[], true)?;
    let mut functions = BTreeMap::<String, Vec<usize>>::new();
    for (i, f) in s.functions.iter().enumerate() {
        let path = match f.context.path(&s, &f.module, &f.name) {
            Ok(path) => path,
            Err(_) if f.target.is_none() => continue,
            Err(err) => return Err(err),
        };
        functions.entry(path.clone()).or_default().push(i);
        if let CallableContext::TraitImpl {
            self_ty, generics, ..
        } = &f.context
        {
            let ty = s.render_type(self_ty, &f.module, generics)?;
            functions
                .entry(format!("{ty}::{}", f.name))
                .or_default()
                .push(i);
        }
    }
    let mut result = vec![];
    let mut targets = BTreeSet::new();
    for h in &s.functions {
        let Some(target) = &h.target else {
            continue;
        };
        let path = if let Some(qself) = &target.qself {
            let mut trait_path = target.path.clone();
            let method = trait_path
                .segments
                .pop()
                .context("Missing method")?
                .into_value();
            ensure!(
                qself.position == trait_path.segments.len(),
                "Unsupported qualified contract target"
            );
            let self_ty = s.render_type(&qself.ty, &h.module, &syn::Generics::default())?;
            if qself.position == 0 {
                format!("{self_ty}::{}", method.ident)
            } else {
                let tr = s.render_path(&trait_path, &h.module, &syn::Generics::default())?;
                format!("<{self_ty} as {tr}>::{}", method.ident)
            }
        } else if target
            .path
            .segments
            .first()
            .is_some_and(|p| p.ident == "Self")
        {
            let owner = h.context.self_ty().context("Self outside an impl")?;
            let generics = match &h.context {
                CallableContext::TraitImpl { generics, .. } => generics.clone(),
                _ => syn::Generics::default(),
            };
            let owner = if matches!(h.context, CallableContext::Inherent { .. }) {
                s.nominal_type(owner, &h.module)?
                    .context("Unsupported inherent self type")?
            } else {
                s.render_type(owner, &h.module, &generics)?
            };
            let parts = segments(&target.path)?;
            format!("{owner}::{}", parts[1..].join("::"))
        } else {
            let parts = segments(&target.path)?;
            let resolved = s.resolve(&parts, &h.module, 0)?;
            if functions.contains_key(&resolved) {
                resolved
            } else {
                format!("{}::{resolved}", s.project.lib_name)
            }
        };
        let indices = functions.get(&path).with_context(|| format!("Cannot resolve {path} in harness {}. Glob imports and generated functions require compiler-backed resolution.", h.path))?;
        ensure!(indices.len() == 1, "Ambiguous contract target {path}");
        let f = &s.functions[indices[0]];
        let identity = f.context.path(&s, &f.module, &f.name)?;
        ensure!(
            targets.insert(identity.clone()),
            "Multiple contract harnesses target {identity}; only one per API is supported"
        );
        ensure!(
            f.public,
            "Contract target {path} is not a public function/method"
        );
        let precondition = if f.requires.is_empty() {
            "true".into()
        } else {
            f.requires
                .iter()
                .map(|r| format!("({r})"))
                .collect::<Vec<_>>()
                .join(" && ")
        };
        let api_paths = s.public_callable_paths(&f.context, &f.module, &f.name)?;
        ensure!(
            !api_paths.is_empty(),
            "Contract target {identity} has no public API path"
        );
        result.push(Contract {
            spec: None,
            api_paths,
            precondition,
            file: h.file.clone(),
            first_line: h.first,
            last_line: h.last,
            harness: h.path.clone(),
        });
    }
    if s.ordinary > 0 {
        eprintln!(
            "Note: {} ordinary #[kani::proof] harness(es) are not publication targets.",
            s.ordinary
        );
    }
    ensure!(
        !result.is_empty(),
        "No #[kani::proof_for_contract] harnesses found in the selected library/configuration"
    );
    result.sort_by(|a, b| a.api_paths.cmp(&b.api_paths));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project(source: &str) -> (tempfile::TempDir, Project) {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("lib.rs");
        fs::write(&root, source).unwrap();
        let p = Project {
            config_override: None,
            name: "demo".into(),
            lib_name: "demo".into(),
            version: "1.0.0".into(),
            manifest: d.path().join("Cargo.toml"),
            root_source: root,
            features: BTreeSet::new(),
            cfg: BTreeSet::from(["kani".into()]),
        };
        (d, p)
    }
    #[test]
    fn structural_paths_match_importer_fixtures() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/canonical-trait-paths.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let ty = case["source"].as_str().unwrap();
            let generic = case["generics"].as_str().unwrap_or("");
            let imports = case["imports"].as_str().unwrap_or("");
            let source = format!("{imports} pub trait T {{ fn m(); }} impl{generic} T for {ty} {{ #[requires(true)] fn m() {{}} }}");
            let contracts = creusot_contracts(&source, CreusotTarget::Annotated);
            assert_eq!(
                contracts[0].api_paths,
                [format!("<{} as demo::T>::m", case["key"].as_str().unwrap())],
                "{source}"
            );
            // Concrete qualified Kani targets use the same renderer as impls.
            if generic.is_empty() {
                let source =
                    format!("{source} #[kani::proof_for_contract(<{ty} as T>::m)] fn check() {{}}");
                let (_d, p) = project(&source);
                assert_eq!(
                    discover(&p).unwrap()[0].api_paths,
                    contracts[0].api_paths,
                    "{source}"
                );
            }
        }
    }
    #[test]
    fn structural_trait_aliases_generic_arguments_and_private_traits() {
        let source = "mod inner { use alloc::vec::Vec as Bytes; pub trait T<A> { fn m(); } impl T<u16> for Bytes<u8> { #[requires(true)] fn m() {} } } pub use inner::T as Export;";
        let c = creusot_contracts(source, CreusotTarget::Annotated);
        assert_eq!(
            c[0].api_paths,
            ["<alloc::vec::Vec<u8> as demo::Export<u16>>::m"]
        );
        let (_d, mut p) = project(
            "trait Private { fn m(); } impl Private for u8 { #[requires(true)] fn m() {} }",
        );
        p.cfg = BTreeSet::from(["creusot".into()]);
        assert!(discover_for_tool(
            &p,
            &Tool {
                name: "creusot".into(),
                version: "test".into(),
                target: Some(CreusotTarget::Annotated),
                ..Tool::default()
            }
        )
        .unwrap_err()
        .to_string()
        .contains("No eligible"));
    }
    #[test]
    fn nested_local_types_use_public_reexports() {
        let c = creusot_contracts("mod hidden { pub struct S; pub trait T { fn m(); } impl T for Vec<S> { #[requires(true)] fn m() {} } } pub use hidden::{S as Alias, T};", CreusotTarget::Annotated);
        assert_eq!(
            c[0].api_paths,
            ["<alloc::vec::Vec<demo::Alias> as demo::T>::m"]
        );
    }
    #[test]
    fn self_qualified_targets_keep_impl_identity() {
        let (_d, p) = project("mod inner { pub struct S; pub trait T { fn m(); } impl T for S { fn m() {} #[kani::proof_for_contract(Self::m)] fn check() {} } } pub use inner::{S, T};");
        assert_eq!(
            discover(&p).unwrap()[0].api_paths,
            ["<demo::S as demo::T>::m"]
        );
    }
    #[test]
    fn generic_local_nominal_identity_remains_erased() {
        let c = creusot_contracts(
            "pub struct S<U>(U); pub trait T {} impl<U> T for S<U> { #[requires(true)] fn m() {} }",
            CreusotTarget::Annotated,
        );
        assert_eq!(c[0].api_paths, ["<demo::S as demo::T>::m"]);
    }
    #[test]
    fn extracts_cfg_attrs_conditions_aliases_and_lines() {
        let (_d, p) = project("\n#[cfg_attr(kani, kani::requires(x > 0))]\n#[kani::requires(x < 10)]\npub fn f(x: u8) {}\n#[cfg(kani)]\nmod verification {\nuse super::f as target;\n#[kani::proof_for_contract(target)]\nfn check() {}\n}\n");
        let c = discover(&p).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].api_paths, ["f"]);
        assert_eq!(c[0].precondition, "(x > 0) && (x < 10)");
        assert_eq!(c[0].first_line, 8);
        assert_eq!(c[0].last_line, 9);
    }
    #[test]
    fn documentation_cfg_is_inactive_unless_selected() {
        let (_d, mut p) = project("#![cfg_attr(docsrs, feature(doc_cfg))]\n#[cfg_attr(docsrs, doc(cfg(feature = \"std\")))]\npub fn normal() {}\n#[cfg(docsrs)] pub fn docs_only() {}\n#[cfg(doc)] pub fn rustdoc_only() {}\n");
        let paths = |p: &Project| {
            public_contracts(p, false, CreusotTarget::All)
                .unwrap()
                .into_iter()
                .flat_map(|c| c.api_paths)
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(&p), ["normal"]);
        p.cfg.insert("docsrs".into());
        assert_eq!(paths(&p), ["docs_only", "normal"]);
        p.cfg.insert("doc".into());
        assert_eq!(paths(&p), ["docs_only", "normal", "rustdoc_only"]);
        let (_d, p) = project("#[cfg(unknown_documentation_mode)] pub fn unknown() {}");
        assert!(public_contracts(&p, false, CreusotTarget::All).is_err());
    }
    #[test]
    fn rejects_multiple_harnesses() {
        let (_d, p) = project("pub fn f() {} #[kani::proof_for_contract(f)] fn a() {} #[kani::proof_for_contract(f)] fn b() {}");
        assert!(discover(&p).unwrap_err().to_string().contains("Multiple"));
    }
    #[test]
    fn method_reexport_and_true() {
        let (_d, p) = project("mod inner { pub struct S; impl S { pub fn f() {} } #[kani::proof_for_contract(S::f)] fn check() {} } pub use inner::S;");
        let c = discover(&p).unwrap();
        assert!(c[0].api_paths.contains(&"S::f".into()));
        assert_eq!(c[0].precondition, "true");
    }
    #[test]
    fn trait_impl_qualified_target_and_public_reexports() {
        let (_d, p) = project("mod hidden { pub struct S; pub trait T { fn m(&self); } impl T for S { #[kani::requires(true)] fn m(&self) {} } #[kani::proof_for_contract(<S as T>::m)] fn check() {} } pub use hidden::{S as Alias, T as PublicTrait};");
        let c = discover(&p).unwrap();
        assert!(c[0]
            .api_paths
            .contains(&"<demo::Alias as demo::PublicTrait>::m".into()));
        assert_eq!(c[0].api_paths, ["<demo::Alias as demo::PublicTrait>::m"]);
    }
    #[test]
    fn same_named_trait_methods_are_distinct() {
        let (_d, p) = project("pub struct S; pub trait A { fn m(&self); } pub trait B { fn m(&self); } impl A for S { fn m(&self) {} } impl B for S { fn m(&self) {} } #[kani::proof_for_contract(<S as A>::m)] fn a() {} #[kani::proof_for_contract(<S as B>::m)] fn b() {}");
        let c = discover(&p).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].api_paths, ["<demo::S as demo::A>::m"]);
        assert_eq!(c[1].api_paths, ["<demo::S as demo::B>::m"]);
        let (_d, p) = project("pub struct S; pub trait A { fn m(&self); } pub trait B { fn m(&self); } impl A for S { fn m(&self) {} } impl B for S { fn m(&self) {} } #[kani::proof_for_contract(S::m)] fn check() {}");
        assert!(discover(&p).unwrap_err().to_string().contains("Ambiguous"));
    }
    #[test]
    fn ignores_disabled_module_and_ordinary_proof() {
        let (_d, p) = project("#[cfg(feature=\"other\")] mod missing; pub fn f() {} #[kani::proof] fn ordinary() {} #[kani::proof_for_contract(f)] fn check() {}");
        assert_eq!(discover(&p).unwrap().len(), 1);
    }
    #[test]
    fn external_module_and_unknown_target() {
        let (d, p) = project("pub mod child;");
        fs::write(
            d.path().join("child.rs"),
            "pub fn f() {} #[kani::proof_for_contract(self::f)] fn check() {}",
        )
        .unwrap();
        assert_eq!(discover(&p).unwrap()[0].api_paths, ["child::f"]);
        fs::write(
            d.path().join("child.rs"),
            "#[kani::proof_for_contract(missing)] fn check() {}",
        )
        .unwrap();
        assert!(discover(&p).is_err());
    }
    fn creusot_contracts(source: &str, target: CreusotTarget) -> Vec<Contract> {
        let (_d, mut p) = project(source);
        p.cfg = BTreeSet::from(["creusot".into()]);
        discover_for_tool(
            &p,
            &Tool {
                name: "creusot".into(),
                version: "test".into(),
                target: Some(target),
                ..Tool::default()
            },
        )
        .unwrap()
    }
    #[test]
    fn creusot_specs_preserve_source_and_active_aliases() {
        let source = r#"use creusot_std::{requires as pre, ensures as post};
// Unicode before spans: 日本語
#[pre( /* input */ é@ > 0 )]
#[cfg_attr(creusot, post(result@ == é@ + 1))]
#[cfg_attr(not(creusot), post(false))]
#[post(forall<i: Int> i >= 0 ==> result@ > i || i >= é@)]
pub fn next<T>(é: u32, value: T) -> u32
where T: Copy
{ é + 1 }
"#;
        let c = creusot_contracts(source, CreusotTarget::Annotated);
        let spec = c[0].spec.as_ref().unwrap();
        assert_eq!(
            spec.signature,
            "pub fn next<T>(é: u32, value: T) -> u32\nwhere T: Copy"
        );
        assert_eq!(spec.requires, [" /* input */ é@ > 0 "]);
        assert_eq!(
            spec.ensures,
            [
                "result@ == é@ + 1",
                "forall<i: Int> i >= 0 ==> result@ > i || i >= é@"
            ]
        );
        assert_eq!(c[0].precondition, "( /* input */ é@ > 0 )");
    }

    #[test]
    fn creusot_specs_include_methods_and_unannotated_targets() {
        let c = creusot_contracts(
            r#"pub struct S;
impl S {
    #[ensures((^self).value == 1)]
    pub fn update(&mut self) {}
}
pub fn plain() {}
"#,
            CreusotTarget::All,
        );
        let method = c
            .iter()
            .find(|c| c.harness == "S::update")
            .unwrap()
            .spec
            .as_ref()
            .unwrap();
        assert_eq!(method.signature, "pub fn update(&mut self)");
        assert_eq!(method.ensures, ["(^self).value == 1"]);
        let plain = c
            .iter()
            .find(|c| c.harness == "plain")
            .unwrap()
            .spec
            .as_ref()
            .unwrap();
        assert!(plain.requires.is_empty() && plain.ensures.is_empty());
    }

    #[test]
    fn creusot_pearlite_and_exclusions() {
        let source = r#"use creusot_std::prelude::*;
#[requires(forall<i: Int> 0 <= i && i < xs@.len() ==> xs@[i] >= 0)]
#[requires(é@ > 0)]
#[ensures(result@ >= 0)]
pub fn sum(xs: &[u32], é: u32) -> u32 { 0 }
#[ensures(result)]
pub fn yes() -> bool { true }
pub fn plain() {}
#[trusted] #[requires(true)] pub fn trusted() {}
#[logic] pub fn model(x: u32) -> Int { x@ }
#[predicate] pub fn pred(x: u32) -> bool { x@ > 0 }
#[check(ghost)] pub fn lemma() {}
#[law] pub fn law() -> bool { true }
#[requires(true)] fn private() {}
#[cfg(kani)] pub fn kani_only() {}
"#;
        let c = creusot_contracts(source, CreusotTarget::Annotated);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].api_paths, ["sum"]);
        assert_eq!(
            c[0].precondition,
            "(forall<i: Int> 0 <= i && i < xs@.len() ==> xs@[i] >= 0) && (é@ > 0)"
        );
        assert_eq!((c[0].first_line, c[0].last_line), (2, 5));
        assert_eq!(c[1].precondition, "true");
        let all = creusot_contracts(source, CreusotTarget::All);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].api_paths, ["plain"]);
    }
    #[test]
    fn creusot_public_methods_reexports_and_cfg() {
        let c = creusot_contracts(
            r#"
mod hidden {
    pub struct Public;
    struct Private;
    impl Public { #[requires(true)] pub fn f(&self) {} }
    impl Private { #[requires(true)] pub fn no(&self) {} }
    #[requires(true)] pub fn hidden() {}
    #[requires(true)] pub fn exported() {}
}
pub use hidden::{Public as Alias, exported};
#[cfg_attr(creusot, creusot_std::requires(x@ > 0))]
pub fn cfg(x: u32) {}
#[cfg(not(creusot))] pub fn no() {}
#[cfg(feature="absent")] mod missing;
"#,
            CreusotTarget::Annotated,
        );
        assert_eq!(
            c.iter()
                .map(|c| c.api_paths[0].as_str())
                .collect::<Vec<_>>(),
            ["Alias::f", "cfg", "exported"]
        );
        assert_eq!(c[1].precondition, "(x@ > 0)");
    }
    #[test]
    fn creusot_trait_impl_method() {
        let c = creusot_contracts("pub struct S; pub trait T { fn m(&self); } impl T for S { #[requires(true)] fn m(&self) {} }", CreusotTarget::Annotated);
        assert_eq!(c[0].api_paths, ["<demo::S as demo::T>::m"]);
    }

    #[test]
    fn nested_external_trait_paths_do_not_include_private_module() {
        let c = creusot_contracts(
            r#"
mod date {
    use std::fmt::Display;
    use std::str::FromStr;
    pub struct HttpDate;
    impl Display for HttpDate { #[ensures(true)] fn fmt(&self) {} }
    impl FromStr for HttpDate { #[ensures(true)] fn from_str() {} }
}
pub use date::HttpDate;
"#,
            CreusotTarget::Annotated,
        );
        assert_eq!(c.len(), 2);
        assert_eq!(
            c[0].api_paths,
            [
                "<demo::HttpDate as Display>::fmt",
                "<demo::HttpDate as std::fmt::Display>::fmt"
            ]
        );
        assert_eq!(
            c[1].api_paths,
            [
                "<demo::HttpDate as FromStr>::from_str",
                "<demo::HttpDate as std::str::FromStr>::from_str"
            ]
        );
        assert_eq!(
            c[0].harness,
            "<demo::date::HttpDate as std::fmt::Display>::fmt"
        );
    }

    #[test]
    fn nested_external_traits_keep_qualification_and_local_trait_identity() {
        let c = creusot_contracts(
            "mod hidden { use custom::Default; pub struct S; pub trait T {} impl Default for S { #[ensures(true)] fn default() {} } impl T for S { #[ensures(true)] fn m() {} } } pub use hidden::{S, T};",
            CreusotTarget::Annotated,
        );
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].api_paths, ["<demo::S as custom::Default>::default"]);
        assert_eq!(c[1].api_paths, ["<demo::S as demo::T>::m"]);
    }

    #[test]
    fn core_parser_formatter_traits_have_catalog_aliases() {
        let c = creusot_contracts(
            "use core::fmt::Display; use core::str::FromStr; pub struct S; impl Display for S { #[ensures(true)] fn fmt(&self) {} } impl FromStr for S { #[ensures(true)] fn from_str() {} }",
            CreusotTarget::Annotated,
        );
        assert_eq!(c.len(), 2);
        assert_eq!(
            c[0].api_paths,
            [
                "<demo::S as Display>::fmt",
                "<demo::S as core::fmt::Display>::fmt"
            ]
        );
        assert_eq!(
            c[1].api_paths,
            [
                "<demo::S as FromStr>::from_str",
                "<demo::S as core::str::FromStr>::from_str"
            ]
        );
    }

    #[test]
    fn custom_and_local_parser_formatter_traits_have_no_standard_aliases() {
        let c = creusot_contracts(
            "mod hidden { use custom::Display; use custom::FromStr; pub struct S; impl Display for S { #[ensures(true)] fn fmt(&self) {} } impl FromStr for S { #[ensures(true)] fn from_str() {} } } pub use hidden::S;",
            CreusotTarget::Annotated,
        );
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].api_paths, ["<demo::S as custom::Display>::fmt"]);
        assert_eq!(c[1].api_paths, ["<demo::S as custom::FromStr>::from_str"]);
        let c = creusot_contracts(
            "pub struct S; pub trait Display {} pub trait FromStr {} impl Display for S { #[ensures(true)] fn fmt(&self) {} } impl FromStr for S { #[ensures(true)] fn from_str() {} }",
            CreusotTarget::Annotated,
        );
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].api_paths, ["<demo::S as demo::Display>::fmt"]);
        assert_eq!(c[1].api_paths, ["<demo::S as demo::FromStr>::from_str"]);
    }

    #[test]
    fn standard_trait_catalog_aliases_are_explicit_and_limited() {
        let c = creusot_contracts("use core::default::Default; pub struct S; impl Default for S { #[ensures(true)] fn default() -> Self { S } }", CreusotTarget::Annotated);
        assert_eq!(
            c[0].api_paths,
            [
                "<demo::S as Default>::default",
                "<demo::S as core::default::Default>::default"
            ]
        );
        assert_eq!(external_trait_paths("custom::Default"), ["custom::Default"]);
        assert_eq!(
            external_trait_paths("core::hash::Hasher"),
            ["core::hash::Hasher", "Hasher"]
        );
    }
    #[test]
    fn creusot_imported_macro_aliases_and_external_modules() {
        let (d, mut p) = project("pub mod child;");
        p.cfg = BTreeSet::from(["creusot".into()]);
        fs::write(
            d.path().join("child.rs"),
            r#"
#[pre(x@ >= 1)] pub fn f(x: u32) {}
#[trust] pub fn skipped() {}
use creusot_std::{requires as pre, trusted as trust};
"#,
        )
        .unwrap();
        let tool = Tool {
            name: "creusot".into(),
            version: "test".into(),
            target: Some(CreusotTarget::All),
            ..Tool::default()
        };
        let c = discover_for_tool(&p, &tool).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].api_paths, ["child::f"]);
        assert_eq!(c[0].precondition, "(x@ >= 1)");
    }
}
