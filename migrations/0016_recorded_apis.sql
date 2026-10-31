-- CLI observations retain exact callable identities without a docs.rs prerequisite.
CREATE TABLE api_item_provenance (
  api_item_id TEXT PRIMARY KEY REFERENCES api_items(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK(origin='recorded')
);
CREATE TABLE run_api_observations (
  run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
  contract_index INTEGER NOT NULL CHECK(contract_index>=0),
  api_item_id TEXT NOT NULL REFERENCES api_items(id),
  PRIMARY KEY(run_id,contract_index)
);
CREATE INDEX run_api_observation_api ON run_api_observations(api_item_id,run_id);
