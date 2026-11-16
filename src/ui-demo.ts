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
    source_url: "#demo-source",
    check_url: "#demo-check",
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
      docs: "Returns a reference to the element at the given index.",
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
      docs: "Appends a value when there is room in the collection.",
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
      docs: "Removes all elements from the collection.",
      signature: "pub fn clear<T>(items: &mut Vec<T>)",
      report_revision: 1,
    },
  ];
  return `<h1>Specification UI demo</h1><nav class="report-outline"><a href="#apis">APIs</a> · <a href="#types">Types</a> · <a href="#predicates">Predicates</a></nav>${reportAPIs({ crate: "demo", tool: "Creusot", synthetic: true, claims })}<section class="report-apis report-section" id="types"><h2>Types</h2><div class="catalog-row"><details class="api-doc" open><summary class="api-doc-heading"><code><span class="rust-keyword">pub struct</span> BoundedVec&lt;T&gt;</code></summary><div class="api-contract"><div class="contract-clause"><div class="contract-label">Invariant</div><pre><code>self.items.len() &lt;= self.capacity</code></pre></div><div class="api-doc-comment markdown-body"><p>A vector whose length never exceeds its capacity.</p></div><footer class="contract-evidence"><a href="#demo-type-source">[src]</a><a href="#demo-check">[proof]</a></footer></div></details></div></section><section class="report-apis report-section" id="predicates"><h2>Predicates</h2><div class="catalog-row"><details class="api-doc" id="predicate-valid-index" open><summary class="api-doc-heading"><code><span class="rust-keyword">fn</span> valid_index(index: usize, length: usize) -&gt; bool</code></summary><div class="api-contract"><div class="contract-clause"><div class="contract-label">Definition</div><pre><code>index &lt; length</code></pre></div><div class="api-doc-comment markdown-body"><p>Checks whether an index is within the collection.</p></div><footer class="contract-evidence"><a href="#demo-predicate-source">[src]</a></footer></div></details></div><div class="catalog-row"><details class="api-doc" id="predicate-within-capacity" open><summary class="api-doc-heading"><code><span class="rust-keyword">fn</span> within_capacity(length: usize, capacity: usize) -&gt; bool</code></summary><div class="api-contract"><div class="contract-clause"><div class="contract-label">Definition</div><pre><code>length &lt; capacity</code></pre></div><div class="api-doc-comment markdown-body"><p>Checks whether another element fits within the capacity.</p></div><footer class="contract-evidence"><a href="#demo-predicate-source">[src]</a></footer></div></details></div></section><details class="report-section"><summary>Type and predicate source</summary><pre id="demo-type-source"><code>pub struct BoundedVec&lt;T&gt; {
    items: Vec&lt;T&gt;,
    capacity: usize,
}</code></pre><pre id="demo-predicate-source"><code>fn valid_index(index: usize, length: usize) -&gt; bool { index &lt; length }
fn within_capacity(length: usize, capacity: usize) -&gt; bool { length &lt; capacity }</code></pre></details><details class="report-section"><summary>Source</summary><pre id="demo-source"><code>pub fn get&lt;T&gt;(items: &amp;[T], index: usize) -&gt; Option&lt;&amp;T&gt; {
    items.get(index)
}

pub fn push&lt;T&gt;(items: &amp;mut Vec&lt;T&gt;, value: T, capacity: usize) -&gt; bool {
    if items.len() &lt; capacity { items.push(value); true } else { false }
}</code></pre></details><details class="report-section"><summary>Proof</summary><pre id="demo-check"><code>Creusot: get, push
Verification conditions: passed</code></pre></details>`;
}
