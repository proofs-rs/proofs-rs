// Synthetic examples for reviewing the proposed specification-first UI.
export function uiDemo(reportAPIs: (report: unknown) => string) {
  const valid = {
    name: "valid_index",
    module: "demo",
    source_url: "#predicate-valid-index",
  };
  const bounded = {
    name: "within_capacity",
    module: "demo",
    source_url: "#predicate-within-capacity",
  };
  const formal = (
    predicate: string,
    args: string,
    source: string,
    ensures: string,
  ) => ({
    kind: "creusot",
    requires: [`${predicate}(${args})`],
    requires_segments: [
      [{ text: predicate, ref: source }, { text: `(${args})` }],
    ],
    ensures: [ensures],
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
        "valid_index",
        "index, items.len()",
        valid.source_url,
        "result.is_some()",
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
        "within_capacity",
        "items.len(), capacity",
        bounded.source_url,
        "result",
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
  return `<h1>Specification UI demo</h1><p class="meta">Synthetic data for staging review. These are examples, not recorded verification results.</p><nav class="report-outline"><a href="#apis">APIs</a> · <a href="#predicates">Predicates</a></nav>${reportAPIs({ crate: "demo", tool: "Synthetic example", synthetic: true, claims })}<section class="report-section" id="predicates"><h2>Predicates</h2><p class="meta">The following definitions and evaluations are synthetic examples.</p><article id="predicate-valid-index" class="predicate-demo"><h3><code>valid_index</code></h3><pre><code>fn valid_index(index: usize, length: usize) -&gt; bool {
  index &lt; length
}</code></pre><form data-predicate-demo="valid-index"><label>Index <input name="first" type="number" min="0" max="9007199254740991" step="1" value="2" required></label> <label>Length <input name="second" type="number" min="0" max="9007199254740991" step="1" value="4" required></label> <button>Evaluate</button> <output aria-live="polite"></output></form></article><article id="predicate-within-capacity" class="predicate-demo"><h3><code>within_capacity</code></h3><pre><code>fn within_capacity(length: usize, capacity: usize) -&gt; bool {
  length &lt; capacity
}</code></pre><form data-predicate-demo="within-capacity"><label>Length <input name="first" type="number" min="0" max="9007199254740991" step="1" value="4" required></label> <label>Capacity <input name="second" type="number" min="0" max="9007199254740991" step="1" value="4" required></label> <button>Evaluate</button> <output aria-live="polite"></output></form></article><p class="meta">Only these sample predicates can be evaluated in this mock. Evaluation runs in your browser.</p></section>`;
}
