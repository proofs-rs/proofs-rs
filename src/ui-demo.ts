// Synthetic examples for reviewing the proposed specification-first UI.
export function uiDemo(reportAPIs: (report: unknown) => string) {
  const valid = {
    name: "demo.valid_index",
    module: "demo",
    source_url: "#predicate-valid-index",
  };
  const bounded = {
    name: "demo.within_capacity",
    module: "demo",
    source_url: "#predicate-within-capacity",
  };
  const formal = (
    name: string,
    expression: string,
    definition: typeof valid,
    binders: any[],
  ) => ({
    theorem: name,
    binders,
    conclusion: expression,
    conclusion_segments: [
      { text: definition.name, ref: definition.name },
      { text: expression.slice(definition.name.length) },
    ],
    definitions: [definition],
  });
  const variable = (name: string, type: string) => ({
    kind: "variable",
    name,
    type,
  });
  const claims = [
    {
      id: "mock-1",
      api_item_id: "mock-get",
      display_path: "demo::get",
      kind: "function",
      signature: "pub fn get<T>(items: &[T], index: usize) -> Option<&T>",
      report_revision: 1,
      formal_evidence: formal(
        "get_spec",
        "demo.valid_index index items.length → result.isSome",
        valid,
        [variable("items", "List T"), variable("index", "Nat")],
      ),
    },
    {
      id: "mock-2",
      api_item_id: "mock-push",
      display_path: "demo::push",
      kind: "function",
      signature:
        "pub fn push<T>(items: &mut Vec<T>, value: T, capacity: usize) -> bool",
      report_revision: 1,
      formal_evidence: formal(
        "push_spec",
        "demo.within_capacity items.length capacity → result = true",
        bounded,
        [variable("items", "List T"), variable("capacity", "Nat")],
      ),
    },
    {
      id: "mock-3",
      api_item_id: "mock-clear",
      display_path: "demo::clear",
      kind: "function",
      signature: "pub fn clear<T>(items: &mut Vec<T>)",
      report_revision: 1,
    },
  ];
  return `<h1>Specification UI demo</h1><p class="meta">Synthetic data for staging review. These are examples, not recorded verification results.</p><nav class="report-outline"><a href="#apis">APIs</a> · <a href="#predicates">Predicates</a></nav>${reportAPIs({ crate: "demo", tool: "Synthetic example", synthetic: true, claims })}<section class="report-section" id="predicates"><h2>Predicates</h2><p class="meta">The following definitions and evaluations are synthetic examples.</p><article id="predicate-valid-index" class="predicate-demo"><h3><code>demo.valid_index</code></h3><pre><code>def valid_index (index length : Nat) : Bool :=
  index &lt; length</code></pre><form data-predicate-demo="valid-index"><label>Index <input name="first" type="number" min="0" max="9007199254740991" step="1" value="2" required></label> <label>Length <input name="second" type="number" min="0" max="9007199254740991" step="1" value="4" required></label> <button>Evaluate</button> <output aria-live="polite"></output></form></article><article id="predicate-within-capacity" class="predicate-demo"><h3><code>demo.within_capacity</code></h3><pre><code>def within_capacity (length capacity : Nat) : Bool :=
  length &lt; capacity</code></pre><form data-predicate-demo="within-capacity"><label>Length <input name="first" type="number" min="0" max="9007199254740991" step="1" value="4" required></label> <label>Capacity <input name="second" type="number" min="0" max="9007199254740991" step="1" value="4" required></label> <button>Evaluate</button> <output aria-live="polite"></output></form></article><p class="meta">Only these sample predicates can be evaluated in this mock. Evaluation runs in your browser.</p></section>`;
}
