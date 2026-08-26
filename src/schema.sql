-- Slice 0 store: projects and hashed API keys only.
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Slice 2: customer provider keys, encrypted at rest. Never plaintext.
CREATE TABLE IF NOT EXISTS keys_refs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  provider TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Slice 3: jobs, versioned eval sets, membership. eval_sets rows are never updated in place.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  description TEXT NOT NULL,
  limits TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS eval_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_id TEXT,
  version INTEGER NOT NULL,
  previous_eval_set_id TEXT,
  frozen_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (previous_eval_set_id) REFERENCES eval_sets(id)
);

-- Example identity. Do not parent only by eval_set_id; membership is eval_set_members.
CREATE TABLE IF NOT EXISTS evals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  score_how TEXT NOT NULL CHECK (score_how IN ('code', 'person')),
  status TEXT NOT NULL,
  program_check TEXT,
  input_truncated TEXT,
  form_type TEXT,
  form_spec TEXT,
  draft_mark TEXT,
  trusted_mark TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_set_members (
  eval_set_id TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  PRIMARY KEY (eval_set_id, eval_id),
  FOREIGN KEY (eval_set_id) REFERENCES eval_sets(id),
  FOREIGN KEY (eval_id) REFERENCES evals(id)
);

CREATE TABLE IF NOT EXISTS idempotency (
  tool_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  project_id TEXT,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tool_name, idempotency_key)
);

-- Slice 4: async eval runs and per-model results.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  eval_set_id TEXT NOT NULL,
  eval_set_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  code TEXT,
  models TEXT NOT NULL,
  max_eval_spend_usd REAL NOT NULL,
  keys_ref TEXT,
  intent TEXT,
  named_model TEXT,
  new_failures TEXT,
  spend_usd REAL NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (eval_set_id) REFERENCES eval_sets(id)
);

CREATE TABLE IF NOT EXISTS run_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  passed INTEGER NOT NULL,
  reason_short TEXT NOT NULL,
  time_ms REAL NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, eval_id, model_id),
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (eval_id) REFERENCES evals(id)
);

-- Slice 5: model recommendations and developer approval.
CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  eval_set_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  named_model_id TEXT,
  backup_model_ids TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  time_json TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  failing_eval_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (eval_set_id) REFERENCES eval_sets(id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS named_model_approvals (
  recommendation_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_at TEXT NOT NULL,
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(id)
);

-- Slice 7: mark queue, people, marks (J3).
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('marker1', 'marker2', 'third')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS mark_queue (
  eval_set_id TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('waiting', 'one_mark', 'disagree', 'trusted', 'cannot_mark', 'dropped')
  ),
  queued_at TEXT NOT NULL,
  PRIMARY KEY (eval_set_id, eval_id),
  FOREIGN KEY (eval_set_id) REFERENCES eval_sets(id),
  FOREIGN KEY (eval_id) REFERENCES evals(id)
);

CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eval_set_id TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  mark_json TEXT NOT NULL,
  is_third INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (eval_set_id, eval_id, person_id),
  FOREIGN KEY (eval_set_id) REFERENCES eval_sets(id),
  FOREIGN KEY (eval_id) REFERENCES evals(id),
  FOREIGN KEY (person_id) REFERENCES people(id)
);

-- M7: image/PDF attachments shown on the mark screen (display only).
CREATE TABLE IF NOT EXISTS eval_files (
  eval_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (eval_id, path),
  FOREIGN KEY (eval_id) REFERENCES evals(id)
);

-- Live L0: signed policy documents. Do not update a published row.
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body_json TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Live L1 / L6: last full, draft, and optional canary. GET serves last full plus canary.
CREATE TABLE IF NOT EXISTS project_live_state (
  project_id TEXT PRIMARY KEY,
  last_full_policy_id TEXT,
  draft_policy_id TEXT,
  canary_policy_id TEXT,
  canary_percent INTEGER,
  rollback_target_policy_id TEXT,
  hashed_request_count INTEGER NOT NULL DEFAULT 0,
  canary_request_count INTEGER NOT NULL DEFAULT 0,
  fallback_count INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  pii_blocked_count INTEGER NOT NULL DEFAULT 0,
  last_known_loaded_at TEXT,
  stats_updated_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (last_full_policy_id) REFERENCES policies(id),
  FOREIGN KEY (draft_policy_id) REFERENCES policies(id),
  FOREIGN KEY (canary_policy_id) REFERENCES policies(id),
  FOREIGN KEY (rollback_target_policy_id) REFERENCES policies(id)
);

-- Live L6: proposed canary / full / rollback. Apply is the HTML screen.
CREATE TABLE IF NOT EXISTS live_rollouts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('canary', 'full', 'rollback')),
  old_policy_id TEXT,
  new_policy_id TEXT,
  rollback_target_policy_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS policy_approvals (
  policy_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_at TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES policies(id)
);

-- Live L4: redacted live misses. Capture is ingest, not a fifth tool.
CREATE TABLE IF NOT EXISTS samples (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  why TEXT NOT NULL CHECK (why IN ('vendor_error', 'timeout', 'app_reported')),
  input_redacted TEXT NOT NULL,
  output_redacted TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dropped_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- V2: grouped redacted live misses.
CREATE TABLE IF NOT EXISTS sample_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  why TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('new', 'candidate', 'promoted', 'blocked', 'quarantined')
  ),
  sample_count INTEGER NOT NULL,
  exemplar_sample_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, fingerprint),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (exemplar_sample_id) REFERENCES samples(id)
);

-- V2: windowed runtime evidence. Rows are append-only.
CREATE TABLE IF NOT EXISTS runtime_stats_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  policy_id TEXT,
  model_id TEXT,
  feature_id TEXT,
  hashed_request_count INTEGER NOT NULL,
  canary_request_count INTEGER NOT NULL,
  fallback_count INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  pii_blocked_count INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- V2: human-approved automation rules. One current row per project.
CREATE TABLE IF NOT EXISTS live_automation (
  project_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'guarded')),
  auto_canary INTEGER NOT NULL,
  auto_full INTEGER NOT NULL,
  auto_rollback INTEGER NOT NULL,
  allowed_models_json TEXT NOT NULL,
  max_eval_spend_usd REAL NOT NULL,
  min_eval_pass_rate REAL NOT NULL,
  max_fallback_rate REAL NOT NULL,
  max_miss_rate REAL NOT NULL,
  min_canary_age_s INTEGER NOT NULL,
  min_canary_requests INTEGER NOT NULL,
  sample_flood_limit INTEGER NOT NULL,
  expires_at TEXT,
  kill_switch INTEGER NOT NULL,
  frozen INTEGER NOT NULL,
  approved_by TEXT,
  configured_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- V2: one decision cycle result per run.
CREATE TABLE IF NOT EXISTS decision_cycles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  automation_mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'blocked')),
  pending_action TEXT,
  blocked_reason TEXT,
  decision_ids_json TEXT NOT NULL,
  audit_ids_json TEXT NOT NULL,
  live_traffic_changed INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- V2: append-only audit events.
CREATE TABLE IF NOT EXISTS decision_audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  cycle_id TEXT,
  event_type TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
