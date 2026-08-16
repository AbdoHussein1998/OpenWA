#!/usr/bin/env node
/**
 * Shape gate: the hand-written wire types of the two HTTP clients (the JavaScript SDK's types.ts
 * and the dashboard's api.ts) against the DTO schemas of the committed openapi.json.
 *
 * This is the contract verification the repo previously had in name only: every existing gate
 * checks WHICH routes/events/methods exist, none checks request/response body SHAPES — the mocks
 * in each client's own suite are a circular oracle. Why a source-parsing script rather than
 * type-level assertions against a generated contract view: deep comparisons through schema trees
 * this large were observed driving the TypeScript 6 checker to composition-dependent verdicts (the
 * same pair failing in one file, silently passing in another — instantiation-budget degradation),
 * which is worse than no gate at all. Comparing parsed declarations against JSON schemas is
 * deterministic, and it is the same mechanism the other check-* gates trust.
 *
 * What one comparison covers, per mapped pair: field-name sets in both directions, required vs
 * optional (hand `?` vs the schema's `required` array), and — for fields whose both sides reduce
 * to a simple token (primitive, enum literal set, array of those, null union) — the token itself,
 * which is what catches `string` widened to `string | number` or a re-ordered enum growing a
 * member. Complex/nested fields are compared by presence and optionality only; that limit is
 * deliberate (the hand parser stays regular), and the exclusions below record what is known to be
 * unpinned. Every mapping entry must resolve on BOTH sides — a renamed hand type or schema fails
 * loudly instead of being skipped (the vacuous-pass failure mode), and the run refuses to gate
 * fewer than 8 pairs per client for the same reason (the dashboard's mappable surface is smaller than the SDK's; exclusions are explicit and counted either way).
 *
 * Pairs that drift today live in EXCLUDED with a one-line reason, mirroring the per-advisory
 * allowlist culture of check-audit: an exclusion is a recorded decision, not a silent skip, and
 * the goal is to shrink it to zero (usually by tightening the hand type; where the CONTRACT
 * under-describes reality, fix the backend DTO decorator, regenerate, and un-exclude).
 */

import { readFileSync } from 'node:fs';

/** hand file -> { handTypeName: schemaName } */
const MAPPINGS = {
  'sdk/javascript/src/types.ts': {
    AccountRestriction: 'AccountRestrictionDto',
    BatchMessageResult: 'BatchMessageResultDto',
    BatchProgress: 'BatchProgressDto',
    BatchStatusResponse: 'BatchStatusResponseDto',
    BulkMessageContent: 'BulkMessageContentDto',
    BulkMessageItem: 'BulkMessageItemDto',
    BulkMessageResponse: 'BulkMessageResponseDto',
    CallLinkResponse: 'CallLinkResponseDto',
    ChatHistoryMessage: 'ChatHistoryMessageDto',
    ChatSummary: 'ChatSummaryDto',
    GroupInfo: 'GroupInfoDto',
    GroupJoinInfo: 'GroupJoinInfoDto',
    GroupParticipant: 'GroupParticipantDto',
    GroupSummary: 'GroupSummaryDto',
    MessageListResponse: 'MessageListResponseDto',
    MessageResponse: 'MessageResponseDto',
    PairingCodeResponse: 'PairingCodeResponseDto',
    ParticipantPresence: 'ParticipantPresenceDto',
    ProfilePictureResponse: 'ProfilePictureResponseDto',
    ProfilePicturesResponse: 'ProfilePicturesResponseDto',
    SearchHit: 'SearchHitDto',
    SessionResponse: 'SessionResponseDto',
    StatusResult: 'StatusResultDto',
    WebhookResponse: 'WebhookResponseDto',
  },
  'dashboard/src/services/api.ts': {
    AccountRestriction: 'AccountRestrictionDto',
    AuditLog: 'AuditLogDto',
    BatchMessageResult: 'BatchMessageResultDto',
    BatchProgress: 'BatchProgressDto',
    BatchStatusResponse: 'BatchStatusResponseDto',
    BulkMessageItem: 'BulkMessageItemDto',
    Channel: 'ChannelDto',
    ChannelMessage: 'ChannelMessageDto',
    Chat: 'ChatSummaryDto',
    ChatPresence: 'ChatPresenceResponseDto',
    Contact: 'ContactDto',
    CreatedApiKey: 'ApiKeyCreatedResponseDto',
    EngineHistoryMessage: 'ChatHistoryMessageDto',
    MessageResponse: 'MessageResponseDto',
    ParticipantPresence: 'ParticipantPresenceDto',
    ProfilePictureResponse: 'ProfilePictureResponseDto',
    SearchHit: 'SearchHitDto',
    Session: 'SessionResponseDto',
    SessionConfig: 'SessionConfigResponseDto',
    Webhook: 'WebhookResponseDto',
  },
};

/**
 * Floor on the mapping SIZE per client. The per-file compared-pairs guard above cannot see a
 * rewrite that silently DROPS entries (protection shrinks while everything stays green — observed
 * in review: a from-memory rewrite lost four conforming pairs and the run still passed). Raising
 * these floors as pairs are added makes the shrink loud.
 */
const MINIMUM_MAPPED = {
  'sdk/javascript/src/types.ts': 24,
  'dashboard/src/services/api.ts': 20,
};

/** Known drift, deliberately not gated yet — each line is a to-adjudicate follow-up. */
const EXCLUDED = {
  'sdk/javascript/src/types.ts': {
    ChatHistoryMessage: 'field-level differences across the 20+-field history shape; adjudicate pair-by-pair',
    ChatSummary:
      'hand marks every field optional and widens timestamp to string|number; contract requires them, timestamp a number',
    GroupInfo: 'nullable-vs-optional and enum differences across 10+ fields; adjudicate pair-by-pair',
    SessionResponse: 'field-level differences; adjudicate pair-by-pair',
    WebhookResponse:
      'CONTRACT GAP: response schema declares filters as Record<string, never>; fix the backend DTO decorator, then pin',
  },
  'dashboard/src/services/api.ts': {
    Session:
      'BY DESIGN, not drift: the wire always carries engineLoaded, but this client clears it to "unknown" after a websocket status event so the action helpers fall back to the status set — the type models client state, not the wire',
    EngineHistoryMessage:
      'hand models a subset of the history shape (13 contract fields missing, fromMe optional); mirror the full shape',
  },
};

// ── hand-type parsing (declarations follow the regular formatting of the two files) ──

export function parseHandTypes(source) {
  const types = {};
  const parents = {};
  const iface = /export interface (\w+)(?: extends (\w+))? \{([\s\S]*?)\n\}/g;
  for (const [, name, parent, body] of source.matchAll(iface)) {
    types[name] = parseMembers(body);
    if (parent) parents[name] = parent;
  }
  // An `extends` adds the parent's members underneath the child's own (child wins on collision) —
  // without this, every inherited field reads as "missing" and response types like the dashboard's
  // CreatedApiKey (extends ApiKey) can never conform.
  for (const [name, parent] of Object.entries(parents)) {
    if (types[parent]) types[name] = { ...types[parent], ...types[name] };
  }
  return types;
}

/** Splits a declaration body into { field: { optional, token } } via brace-depth scanning. */
function parseMembers(body) {
  const members = {};
  let depth = 0;
  let field = null;
  let buffer = '';
  for (const line of body.split('\n')) {
    const cleaned = line
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/, '')
      .trim();
    if (!cleaned) continue;
    if (depth === 0) {
      const m = cleaned.match(/^(\w+)(\?)?:\s*(.*)$/);
      if (m) {
        field = m[1];
        members[field] = { optional: m[2] === '?', token: m[3] };
        if (m[3].startsWith('{')) {
          depth = countUnbalanced(m[3]);
          buffer = m[3];
        }
        continue;
      }
    }
    if (depth > 0) {
      buffer += ' ' + cleaned;
      depth += countUnbalanced(cleaned);
      if (depth <= 0) members[field].token = buffer.replace(/\s+/g, ' ');
    }
  }
  return members;
}

function countUnbalanced(s) {
  let n = 0;
  for (const ch of s) {
    if (ch === '{' || ch === '[') n++;
    else if (ch === '}' || ch === ']') n--;
  }
  return n;
}

// ── shape tokens: reduce hand TS text and JSON schema nodes to comparable strings ──

const MAX_DEPTH = 4;

export function handToken(text, types, depth = 0) {
  const t = text.trim().replace(/;$/, '');
  if (t.endsWith('[]')) return `array<${handToken(t.slice(0, -2), types, depth)}>`;
  if (/^(string|number|boolean|unknown|any)$/.test(t)) return t;
  const literals = [...t.matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (literals.length && literals.length === t.split('|').length) return `enum(${literals.slice().sort().join(',')})`;
  if (t.includes('|')) {
    const parts = t
      .split('|')
      .map(p => p.trim())
      .filter(p => p && p !== 'undefined');
    const nullable = parts.includes('null');
    const rest = parts.filter(p => p !== 'null');
    if (nullable && rest.length === 1) return `${handToken(rest[0], types, depth)}|null`;
    return `union(${rest
      .map(p => handToken(p, types, depth))
      .sort()
      .join(',')})`;
  }
  const ref = types[t];
  if (ref && depth < MAX_DEPTH) {
    return `object(${Object.entries(ref)
      .map(([f, v]) => `${f}${v.optional ? '?' : ''}:${handToken(v.token, types, depth + 1)}`)
      .sort()
      .join(',')})`;
  }
  return t; // named type not resolvable in this file (e.g. Jid) — compare by name
}

export function schemaToken(node, schemas, depth = 0) {
  const token = baseSchemaToken(node, schemas, depth);
  // OpenAPI 3.0 nullability is a SIBLING flag on the node (`nullable: true`), not a type member —
  // dropping it silently downgraded every honest `string | null` hand type to a false mismatch.
  return node?.nullable === true && !token.endsWith('|null') ? `${token}|null` : token;
}

function baseSchemaToken(node, schemas, depth = 0) {
  if (!node || typeof node !== 'object') return 'any';
  if (node.$ref) {
    const target = schemas[node.$ref.split('/').pop()];
    return depth < MAX_DEPTH ? schemaToken(target, schemas, depth + 1) : 'object';
  }
  if (node.enum) return `enum(${node.enum.slice().sort().join(',')})`;
  if (node.type === 'array') return `array<${schemaToken(node.items, schemas, depth)}>`;
  if (node.anyOf || node.oneOf) {
    const parts = (node.anyOf ?? node.oneOf).map(n => schemaToken(n, schemas, depth + 1));
    const nullable = parts.includes('null');
    const rest = parts.filter(p => p !== 'null').filter(p => p !== 'any' || !nullable);
    if (nullable && rest.length === 1) return `${rest[0]}|null`;
    return `union(${rest.sort().join(',')})`;
  }
  if (node.type === 'object') {
    if (depth >= MAX_DEPTH) return 'object';
    const required = new Set(node.required ?? []);
    const props = Object.entries(node.properties ?? {}).map(
      ([f, v]) => `${f}${required.has(f) ? '' : '?'}:${schemaToken(v, schemas, depth + 1)}`,
    );
    return `object(${props.sort().join(',')})`;
  }
  const t = node.type ?? 'any';
  if (t === 'integer') return 'number';
  return t;
}

/** Splits an object(...) token back into { field: { optional, token } } for field-level diffing. */
export function parseObjectToken(token) {
  const inner = token.match(/^object\((.*)\)$/)?.[1];
  if (inner === undefined) return {};
  const members = {};
  let depth = 0;
  let buffer = '';
  for (const ch of inner) {
    if (ch === ',' && depth === 0) {
      pushMember();
      continue;
    }
    if (ch === '(' || ch === '<' || ch === '{') depth++;
    if (ch === ')' || ch === '>' || ch === '}') depth--;
    buffer += ch;
  }
  pushMember();
  function pushMember() {
    const m = buffer.match(/^(\w+)(\?)?:(.*)$/s);
    if (m) members[m[1]] = { optional: m[2] === '?', token: m[3] };
    buffer = '';
  }
  return members;
}

/** Fields whose both sides reduce to a primitive/enum/array/null-union get token-level diffing. */
function isSimpleToken(token) {
  return /^(string|number|boolean|unknown|any)(\|null)?$|^enum\([^)]*\)$|^array<(string|number|boolean)(\|null)?>$/.test(
    token,
  );
}

/**
 * Compares one hand type against one schema. Returns an array of human-readable diff lines —
 * empty when the pair conforms. Exported for the spec; the CLI loop below is a thin driver.
 */
export function comparePair(handName, handMembers, schemaName, schema, schemas) {
  const diffs = [];
  const schemaFields = parseObjectToken(schemaToken(schema, schemas));
  for (const [field, handInfo] of Object.entries(handMembers)) {
    const sField = schemaFields[field];
    if (!sField) {
      diffs.push(`hand has "${field}" — contract does not`);
      continue;
    }
    if (handInfo.optional !== sField.optional) {
      diffs.push(
        `"${field}": hand ${handInfo.optional ? 'optional' : 'required'}, contract ${sField.optional ? 'optional' : 'required'}`,
      );
      continue;
    }
    if (isSimpleToken(sField.token)) {
      const hand = handToken(handInfo.token, { [handName]: handMembers });
      if (hand !== sField.token && isSimpleToken(hand))
        diffs.push(`"${field}": hand ${hand}, contract ${sField.token}`);
    }
  }
  for (const field of Object.keys(schemaFields)) {
    if (!(field in handMembers)) diffs.push(`contract has "${field}" — hand does not`);
  }
  return diffs;
}

// ── CLI driver ──

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) {
  const openapi = JSON.parse(readFileSync('openapi.json', 'utf8'));
  const schemas = openapi.components.schemas;
  let failures = 0;
  let compared = 0;

  for (const [file, mapping] of Object.entries(MAPPINGS)) {
    const source = readFileSync(file, 'utf8');
    const handTypes = parseHandTypes(source);
    const excluded = EXCLUDED[file] ?? {};
    let fileCompared = 0;
    const fileResults = [];

    for (const [handName, schemaName] of Object.entries(mapping)) {
      if (excluded[handName]) continue;
      const hand = handTypes[handName];
      const schema = schemas[schemaName];
      if (!hand) {
        fileResults.push(`  MISSING hand type ${handName} (declared in mapping but not found in ${file})`);
        failures++;
        continue;
      }
      if (!schema) {
        fileResults.push(`  MISSING schema ${schemaName} (declared in mapping but not in openapi.json)`);
        failures++;
        continue;
      }
      fileCompared++;
      compared++;
      const diffs = comparePair(handName, hand, schemaName, schema, schemas);
      if (diffs.length) {
        fileResults.push(`  ${handName} ↔ ${schemaName}:`, ...diffs.map(d => `    ${d}`));
        failures++;
      }
    }

    if (Object.keys(mapping).length < MINIMUM_MAPPED[file]) {
      fileResults.push(
        `  only ${Object.keys(mapping).length} mapped pairs for ${file} (floor ${MINIMUM_MAPPED[file]}) — entries were dropped`,
      );
      failures++;
    }
    if (fileCompared < 8) {
      fileResults.push(`  only ${fileCompared} pairs compared for ${file} — vacuous-pass guard`);
      failures++;
    }
    console.log(`${file}: ${fileCompared} pairs compared, ${fileResults.length ? 'FAILURES' : 'all conform'}`);
    for (const line of fileResults) console.log(line);
    const excludedCount = Object.keys(excluded).length;
    if (excludedCount) {
      console.log(`  (${excludedCount} excluded pair(s) with recorded reasons — see EXCLUDED in this script)`);
    }
  }

  console.log(
    failures
      ? `\ncheck-contract-shapes: ${failures} failing pair(s) — the contract side wins; tighten the hand type or fix the backend DTO and regenerate.`
      : `\ncheck-contract-shapes: ${compared} pairs conform.`,
  );
  process.exit(failures ? 1 : 0);
}
