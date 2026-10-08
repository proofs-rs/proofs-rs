CREATE TABLE run_dependencies (
  run_id TEXT NOT NULL REFERENCES verification_runs(id),
  crate TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY(run_id,crate,version,source)
);
CREATE TABLE report_dependencies (
  report_id INTEGER NOT NULL,
  revision_no INTEGER NOT NULL,
  crate TEXT NOT NULL,
  version TEXT NOT NULL,
  evidence_report_id INTEGER NOT NULL,
  evidence_revision_no INTEGER NOT NULL,
  PRIMARY KEY(report_id,revision_no,crate),
  FOREIGN KEY(report_id,revision_no) REFERENCES report_revisions(report_id,revision_no),
  FOREIGN KEY(evidence_report_id,evidence_revision_no) REFERENCES report_revisions(report_id,revision_no)
);
CREATE TRIGGER run_dependencies_update BEFORE UPDATE ON run_dependencies WHEN NOT EXISTS(SELECT 1 FROM maintenance) BEGIN SELECT RAISE(ABORT,'immutable_run_dependency'); END;
CREATE TRIGGER run_dependencies_delete BEFORE DELETE ON run_dependencies WHEN NOT EXISTS(SELECT 1 FROM maintenance) BEGIN SELECT RAISE(ABORT,'immutable_run_dependency'); END;
CREATE TRIGGER report_dependencies_update BEFORE UPDATE ON report_dependencies WHEN NOT EXISTS(SELECT 1 FROM maintenance) BEGIN SELECT RAISE(ABORT,'immutable_dependency_review'); END;
CREATE TRIGGER report_dependencies_delete BEFORE DELETE ON report_dependencies WHEN NOT EXISTS(SELECT 1 FROM maintenance) BEGIN SELECT RAISE(ABORT,'immutable_dependency_review'); END;
