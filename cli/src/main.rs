mod aeneas;
mod api;
mod config;
mod draft;
mod git;
mod preview;
mod publish;
mod record;
mod scan;
mod state;
mod toolchain;

const MAX_REPORT_CLAIMS: usize = 200;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "cargo proofs",
    bin_name = "cargo proofs",
    version,
    about = "Publish Rust verification reports to proofs.rs"
)]
struct Cli {
    /// Service origin. Credentials and publication state are isolated per server.
    #[arg(
        long,
        global = true,
        env = "PROOFS_SERVER",
        default_value = "https://proofs.rs"
    )]
    server: String,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Args, Clone, Default)]
pub struct ProjectArgs {
    /// Profile-specific proofs.toml, relative to the selected package directory.
    #[arg(long, global = true)]
    proofs_config: Option<PathBuf>,
    #[arg(long, global = true)]
    manifest_path: Option<PathBuf>,
    /// Select a workspace package.
    #[arg(short = 'p', long, global = true)]
    package: Option<String>,
    #[arg(long, value_delimiter = ',', global = true)]
    features: Vec<String>,
    #[arg(long, global = true)]
    all_features: bool,
    #[arg(long, global = true)]
    no_default_features: bool,
    /// Target used for evaluating conditional compilation (does not run verification).
    #[arg(long, global = true)]
    target: Option<String>,
}
#[derive(Subcommand)]
enum Commands {
    /// Create proofs.toml next to the selected Cargo.toml.
    Init {
        #[command(flatten)]
        project: ProjectArgs,
        #[arg(long)]
        title: Option<String>,
        /// Verification tool used for the existing verification.
        #[arg(long, default_value = "kani", value_parser = ["kani", "creusot", "aeneas"])]
        tool: String,
        /// Creusot API selection (required for Creusot). Not the compilation --target.
        #[arg(long, value_enum, required_if_eq("tool", "creusot"))]
        tool_target: Option<config::CreusotTarget>,
        /// Tool version used for the existing verification (detected if omitted).
        #[arg(long)]
        tool_version: Option<String>,
    },
    /// Restore the configured Aeneas cumulative patch without running proofs.
    Prepare {
        #[command(flatten)]
        project: ProjectArgs,
    },
    /// Authorize this CLI in a browser.
    Login {
        #[arg(long)]
        no_browser: bool,
    },
    /// Revoke and remove this server's saved token.
    Logout,
    /// Verify a detached Git worktree and record results for publication.
    Run {
        #[command(flatten)]
        project: ProjectArgs,
        #[arg(last=true, required=true, num_args=2..)]
        command: Vec<String>,
    },
    /// Preview a recorded report or an unverified draft locally (requires Node.js 24+).
    Preview {
        #[command(flatten)]
        project: ProjectArgs,
        /// Preview local report text and configured mappings without recorded evidence or service access.
        #[arg(long, conflicts_with_all = ["run", "report"])]
        draft: bool,
        /// Select a recorded run (defaults to the latest run at startup).
        #[arg(long)]
        run: Option<String>,
        /// Preview a public report revision (defaults to your saved publication target).
        #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
        report: Option<u64>,
        /// Local port; zero selects an available port.
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Print the URL without opening a browser.
        #[arg(long)]
        no_browser: bool,
    },
    /// Publish recorded SARIF results with embedded execution logs.
    Publish {
        #[command(flatten)]
        project: ProjectArgs,
        /// Validate recorded evidence and API bindings without storing evidence or publishing.
        #[arg(long)]
        dry_run: bool,
        /// Select a recorded run (defaults to the latest run).
        #[arg(long)]
        run: Option<String>,
        /// Attach to an existing report (e.g. from another machine).
        #[arg(long)]
        report: Option<u64>,
        /// Overwrite conflicting web edits after displaying the differences.
        #[arg(long)]
        force: bool,
        /// Explicitly approve removal of claims; does not bypass conflicts or recorded-run checks.
        #[arg(long)]
        yes: bool,
        /// Retry an interrupted publication using its exact saved request.
        #[arg(long, conflicts_with_all = ["dry_run", "run", "report", "force", "yes"])]
        resume: bool,
    },
}
fn run() -> Result<()> {
    let mut args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|x| x == "proofs") {
        args.remove(1);
    }
    let cli = Cli::parse_from(args);
    let server = api::server(&cli.server)?;
    match cli.command {
        Commands::Init {
            project,
            title,
            tool_version,
            tool,
            tool_target,
        } => config::init(&project, title, tool_version, tool, tool_target),
        Commands::Prepare { project } => aeneas::prepare_project(&project),
        Commands::Login { no_browser } => api::login(&server, no_browser),
        Commands::Logout => api::logout(&server),
        Commands::Run { project, command } => record::run(&project, command),
        Commands::Preview {
            project,
            draft,
            run,
            report,
            port,
            no_browser,
        } => preview::run(
            &server,
            &project,
            preview::Options {
                draft,
                run,
                report,
                port,
                no_browser,
            },
        ),
        Commands::Publish {
            project,
            dry_run,
            run,
            report,
            force,
            yes,
            resume,
        } => publish::run(
            &server,
            &project,
            publish::Options {
                dry_run,
                run,
                report,
                force,
                yes,
                resume,
            },
        ),
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn report_profiles_work_for_recorded_and_draft_commands() {
        for command in [
            vec![
                "run",
                "--proofs-config",
                "profiles/default/proofs.toml",
                "--",
                "lake",
                "build",
            ],
            vec!["preview", "--proofs-config", "profiles/default/proofs.toml"],
            vec![
                "preview",
                "--draft",
                "--proofs-config",
                "profiles/default/proofs.toml",
            ],
            vec![
                "publish",
                "--dry-run",
                "--proofs-config",
                "profiles/default/proofs.toml",
            ],
        ] {
            let args = std::iter::once("cargo-proofs").chain(command);
            let parsed = Cli::try_parse_from(args).unwrap();
            let project = match parsed.command {
                Commands::Run { project, .. }
                | Commands::Preview { project, .. }
                | Commands::Publish { project, .. } => project,
                _ => unreachable!(),
            };
            assert_eq!(
                project.proofs_config,
                Some("profiles/default/proofs.toml".into())
            );
        }
        assert!(Cli::try_parse_from(["cargo-proofs", "preview", "--draft", "--run", "a"]).is_err());
    }
}
