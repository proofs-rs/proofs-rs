import { z } from "zod";

// Shared wire schemas. Database-dependent rules stay in the route handlers.
export const string = z.string();
export const number = z.number();
export const integer = z.number().int();
export const flag = z.union([z.literal(0), z.literal(1)]);
export const nullableString = string.nullable();
export const ok = z.object({ ok: z.literal(true) });
export const error = z
  .object({
    error: string,
    message: string.optional(),
    request_id: string.optional(),
  })
  .meta({ id: "Error" });
export const positiveInput = z.union([
  integer.positive(),
  string.regex(/^\d+$/),
]);
const field = (max = 10000) => string.trim().max(max);
const required = (max = 10000) => field(max).min(1);
const optional = (max = 10000) => field(max).optional();
export const pagination = z.object({
  cursor: string
    .optional()
    .describe(
      "Opaque next_cursor from the previous page; omit for the first page.",
    ),
});
export const search = pagination.extend({ q: string.optional() });
export const list = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next_cursor: string.nullable() });
export const token = z.object({
  id: string,
  created_at: string,
  last_used_at: nullableString,
  expires_at: string,
});
export const user = z
  .object({
    id: string,
    github_id: integer,
    username: string,
    role: string,
    status: string,
    accepted_terms_version: string,
    terms_accepted_at: string,
    created_at: string,
    csrf: string.optional(),
    token_id: string.optional(),
  })
  .meta({ id: "SessionUser" });
export const me = z.union([
  z.object({ user: z.null() }),
  z.object({
    user,
    csrf: string,
    email: z
      .object({ address: nullableString, delivery_status: string })
      .nullable(),
    delayed_notifications: integer,
    karma: integer,
    terms_required: z.boolean(),
  }),
]);
export const preferences = z.object({ replies: flag, report_comments: flag });
export const preferencesInput = z.object({
  replies: z.boolean(),
  report_comments: z.boolean(),
});
export const release = z
  .object({
    id: integer,
    crate_id: integer,
    version: string,
    checksum: nullableString,
    yanked: flag,
    created_at: string,
  })
  .meta({ id: "Release" });
export const crate = z
  .object({
    id: integer,
    name: string,
    description: nullableString,
    api_count: integer,
    report_count: integer,
    claim_count: integer,
    updated_at: nullableString,
  })
  .meta({ id: "Crate" });
export const apiItem = z
  .object({
    id: string,
    release_id: integer,
    canonical_key: string,
    display_path: string,
    kind: string,
    is_unsafe: flag,
    signature: string,
    upstream_url: string,
  })
  .meta({ id: "ApiItem" });
export const apiDetail = apiItem.extend({
  crate: string,
  version: string,
  yanked: flag,
  target: nullableString,
  features_json: nullableString,
  rustdoc_format: integer.nullable(),
});
export const toolVersion = z
  .object({
    id: string,
    tool_id: string,
    version: string,
    selectable: flag,
    limitations: string.describe("Displayed as Technical limitations."),
    limitations_updated_at: nullableString,
  })
  .meta({ id: "ToolVersion" });
export const tool = z
  .object({
    id: string,
    name: string,
    description: string,
    official_url: string,
    active: flag,
  })
  .meta({ id: "Tool" });
const reportText = {
  title: string,
  explanation: string,
  trusted_assumptions: string.describe("Displayed as What is trusted."),
  environment: string,
  evidence_url: string,
  limitations: string.describe("Displayed as Technical limitations."),
};
export const report = z
  .object({
    id: integer,
    release_id: integer,
    author_id: nullableString,
    visibility: string,
    withdrawn_at: nullableString,
    created_at: string,
    updated_at: string,
    revision_no: integer,
    ...reportText,
    tool_version_id: string,
    crate: string,
    version: string,
    yanked: flag,
    username: nullableString,
    tool: string,
    tool_version: string,
    tool_limitations: string.describe("Displayed as Technical limitations."),
    tool_limitations_updated_at: nullableString,
    latest_revision_no: integer,
    comment_count: integer,
    star_count: integer,
    author_karma: integer,
    claim_count: integer,
    dependency_count: integer,
  })
  .meta({ id: "Report" });
export const claim = z
  .object({
    id: string,
    kind: string,
    category: nullableString,
    trait_path: nullableString,
    self_type: nullableString,
    method_name: nullableString,
    is_blanket: flag.nullable(),
    claim_number: integer,
    report_id: integer,
    api_item_id: string,
    property: z.enum(["no_ub", "panic_contract"]),
    created_at: string,
    report_revision: integer,
    position: integer,
    title: string,
    precondition: string,
    explanation: string,
    trusted_assumptions: string.describe("Displayed as What is trusted."),
    evidence_url: string,
    limitations: string.describe("Displayed as Technical limitations."),
    display_path: string,
    is_unsafe: flag,
    signature: string,
    upstream_url: string,
    author_id: nullableString,
    withdrawn_at: nullableString,
    visibility: string,
    report_title: string,
    shared_explanation: string,
    shared_trusted_assumptions: string.describe(
      "Displayed as What is trusted.",
    ),
    shared_evidence_url: string,
    shared_limitations: string.describe("Displayed as Technical limitations."),
    environment: string,
    tool_version_id: string,
    crate: string,
    version: string,
    username: nullableString,
    tool: string,
    tool_version: string,
    tool_limitations: string.describe("Displayed as Technical limitations."),
    tool_limitations_updated_at: nullableString,
    latest_report_revision: integer,
    star_count: integer,
    report_star_count: integer,
    report_comment_count: integer,
    author_karma: integer,
    in_current_report: flag,
  })
  .meta({ id: "Claim" });
export const dependencyInput = z.strictObject({
  crate: required(100),
  report: positiveInput,
  revision: positiveInput,
});
export const dependency = z.object({
  crate: string,
  version: string,
  report: integer.nullable(),
  revision: integer.nullable(),
  withdrawn: z.boolean(),
});
export const runDependency = z.object({
  crate: required(100),
  version: required(100),
  source: required(1000),
});
export const reportDetail = report.extend({
  dependencies: z.array(dependency),
  my_star: z.boolean(),
  run_ids: z.array(string),
  claims: z.array(claim.extend({ my_star: z.boolean() })),
});
export const comment = z
  .object({
    id: string,
    report_id: integer,
    sequence_no: integer,
    revision_no: integer,
    author_id: nullableString,
    reply_to_id: nullableString,
    body: nullableString,
    edit_version: integer,
    created_at: string,
    edited_at: nullableString,
    deleted_at: nullableString,
    username: nullableString,
    score: integer,
    my_vote: integer.nullable(),
    reply_count: integer,
    hidden: z.boolean(),
  })
  .meta({ id: "Comment" });
export const discussion = comment.pick({
  id: true,
  report_id: true,
  sequence_no: true,
  revision_no: true,
  body: true,
  created_at: true,
  username: true,
  author_id: true,
});
export const star = z.object({
  id: string,
  username: string,
  created_at: string,
});
const claimFields = {
  api_item_id: required(200),
  property: z.enum(["no_ub", "panic_contract"]),
  title: optional(1000),
  precondition: optional(),
  explanation: optional(),
  trusted_assumptions: optional(),
  evidence_url: optional(1000),
  limitations: optional(),
};
export const reportInput = z
  .object({
    crate: required(100),
    version: required(100),
    tool_version_id: required(200),
    title: required(1000),
    explanation: optional(),
    trusted_assumptions: optional(),
    environment: optional(),
    evidence_url: optional(1000),
    limitations: optional(),
    claims: z
      .array(z.object({ id: required(100).optional(), ...claimFields }))
      .min(1)
      .max(100),
    run_ids: z.array(string).min(1).max(10),
    dependencies: z.array(dependencyInput).max(100).optional(),
  })
  .meta({ id: "ReportInput" });
export const validatedClaim = z.object({
  id: nullableString,
  api_item_id: string,
  property: claimFields.property,
  title: string,
  precondition: string,
  explanation: string,
  trusted_assumptions: string.describe("Displayed as What is trusted."),
  evidence_url: string,
  limitations: string.describe("Displayed as Technical limitations."),
  display_path: string,
  is_unsafe: flag,
  signature: string,
});
export const validatedReport = z.object({
  release_id: integer,
  crate: string,
  version: string,
  ...reportText,
  tool_version_id: string,
  tool: string,
  tool_version: string,
  claims: z.array(validatedClaim),
  run_ids: z.array(string),
  dependencies: z.array(dependency),
  changes: z.object({
    added: integer,
    retained: z.array(string),
    removed: z.array(string),
  }),
});
export const createComment = z.object({
  body: required(5000),
  revision_no: positiveInput,
  reply_to_id: field(100).nullable().optional(),
});
export const deleteComment = z.object({ edit_version: positiveInput });
export const editComment = deleteComment.extend({ body: required(5000) });
export const run = z
  .object({
    id: string,
    author_id: nullableString,
    crate: string,
    version: string,
    tool_version_id: string,
    sha256: string,
    size: integer,
    created_at: string,
    dependencies: z.array(runDependency),
  })
  .meta({ id: "VerificationRun" });
export const uploadedRun = z.object({ id: string, sha256: string });
// Extension properties are allowed, but these are the fields needed to publish
// a recorded run. Cross-field consistency is checked by readRecord.
export const runId = string.regex(
  /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
);
const relativePath = string
  .min(1)
  .max(1000)
  .describe(
    "Relative path without '..', backslashes, colons or control characters.",
  );
const logLocation = z.looseObject({ index: integer.nonnegative() });
export const sarif = z
  .looseObject({
    version: z.literal("2.1.0"),
    runs: z
      .array(
        z.looseObject({
          automationDetails: z.looseObject({ guid: runId }),
          tool: z.looseObject({
            driver: z.looseObject({ name: string.min(1), version: string }),
          }),
          versionControlProvenance: z
            .array(
              z.looseObject({
                repositoryUri: string.regex(
                  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
                ),
                revisionId: string.regex(/^[a-f0-9]{40}$/),
              }),
            )
            .length(1),
          invocations: z
            .array(
              z.looseObject({
                executableLocation: z.looseObject({
                  uri: string.min(1).max(4000),
                }),
                arguments: z.array(string.max(4000)).max(199),
                workingDirectory: z.looseObject({ uri: relativePath }),
                startTimeUtc: string,
                endTimeUtc: string,
                executionSuccessful: z.literal(true),
                exitCode: z.literal(0),
                stdout: logLocation.optional(),
                stderr: logLocation.optional(),
                stdoutStderr: logLocation.optional(),
              }),
            )
            .length(1),
          artifacts: z
            .array(
              z.looseObject({
                contents: z.object({ text: string }).optional(),
              }),
            )
            .describe(
              "At least one invocation log must refer to an artifact containing embedded text. Source contents are not accepted.",
            ),
          results: z
            .array(
              z.looseObject({
                message: z.looseObject({ text: string }),
                kind: z.enum([
                  "pass",
                  "fail",
                  "open",
                  "notApplicable",
                  "informational",
                  "review",
                ]),
                properties: z
                  .looseObject({ harness: string.optional() })
                  .optional(),
              }),
            )
            .max(50000),
          properties: z.looseObject({
            proofs: z.looseObject({
              schemaVersion: z.literal(2),
              dependencies: z.array(runDependency).max(10000),
              crate: required(100),
              version: required(100),
              contracts: z
                .array(
                  z.looseObject({
                    file: relativePath,
                    first_line: integer.positive(),
                    last_line: integer.positive(),
                    harness: string,
                    api_paths: z.array(string).min(1),
                    precondition: string,
                    properties: z
                      .array(z.enum(["no_ub", "panic_contract"]))
                      .min(1),
                  }),
                )
                .min(1)
                .max(100),
            }),
          }),
        }),
      )
      .length(1),
  })
  .meta({
    id: "Sarif",
    description:
      "Recorded SARIF 2.1.0. Each contract needs matching successful results; times, line ranges, paths and log references are checked before storage.",
  });
export const deviceCodeInput = z.object({
  client_id: z.literal("proofs-cli"),
  scope: z.literal("publish").optional(),
});
export const deviceTokenInput = z.object({
  client_id: z.literal("proofs-cli"),
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
  device_code: required(200),
});
export const userCodeInput = z.object({ user_code: required(20) });
export { z };
