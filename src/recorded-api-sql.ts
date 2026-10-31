// Legacy rows were independently imported from rustdoc. Recorded rows carry no
// independent signature/safety assertion and remain hidden until published.
export const recordedAPI = (a = "a") =>
  `EXISTS(SELECT 1 FROM api_item_provenance ap WHERE ap.api_item_id=${a}.id AND ap.origin='recorded')`;
export const apiOrigin = (a = "a") =>
  `CASE WHEN ${recordedAPI(a)} THEN 'recorded' ELSE 'rustdoc' END`;
export const visibleAPI = (a = "a") =>
  `(NOT ${recordedAPI(a)} OR EXISTS(SELECT 1 FROM claims ac JOIN reports ar ON ar.id=ac.report_id WHERE ac.api_item_id=${a}.id AND ar.visibility='public'))`;
export function apiObservation<
  T extends { origin?: string; is_unsafe: unknown },
>(item: T) {
  if (item.origin !== "recorded") return item;
  return {
    ...item,
    is_unsafe: null,
    ...("target" in item
      ? { target: null, features_json: null, rustdoc_format: null }
      : {}),
  };
}
