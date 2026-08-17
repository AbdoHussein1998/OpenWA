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
 * Known blind spots, so nobody reads a green run as more than it is: TypeScript type-ALIASED
 * enums (e.g. `status: SessionStatus`) resolve to their alias name and are compared by presence
 * and optionality only — the literal sets themselves are ungated on the TS clients; and Java
 * enums (record components typed as enum classes) are likewise presence-only. Python Literals and
 * Go const-block enums DO compare literally.
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

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve from the script's own location, not process.cwd() — same reason check-sdk-coverage.mjs
// does: the gate must run identically from any directory (npm run pins cwd, direct invocation
// does not).
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

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
    MessageRecord: 'MessageListItemDto',
    MessageResponse: 'MessageResponseDto',
    // Request-side pairs: every *Request interface with a matching DTO, plus the filter-condition
    // shape. Two requests have NO named schema (inline objects on their routes) and stay unmapped:
    // AddLabelRequest (POST /labels/chat/:chatId) and SubscribeChannelRequest (POST /channels/subscribe).
    ArchiveChatRequest: 'ArchiveChatDto',
    BulkMediaRequest: 'BulkMediaDto',
    CreateCallLinkRequest: 'CreateCallLinkDto',
    CreateChannelRequest: 'CreateChannelDto',
    CreateGroupRequest: 'CreateGroupDto',
    CreateSessionRequest: 'CreateSessionDto',
    CreateTemplateRequest: 'CreateTemplateDto',
    CreateWebhookRequest: 'CreateWebhookDto',
    DeleteChatRequest: 'DeleteChatDto',
    DeleteMessageRequest: 'DeleteMessageDto',
    DemoteChannelAdminRequest: 'DemoteChannelAdminDto',
    EditMessageRequest: 'EditMessageDto',
    ForwardMessageRequest: 'ForwardMessageDto',
    GroupDescriptionRequest: 'GroupDescriptionDto',
    GroupMembershipRequest: 'GroupMembershipRequestDto',
    GroupSubjectRequest: 'GroupSubjectDto',
    JoinGroupRequest: 'JoinGroupDto',
    MarkChatRequest: 'MarkChatReadDto',
    MuteChannelRequest: 'MuteChannelDto',
    MuteChatRequest: 'MuteChatDto',
    ParticipantsRequest: 'ParticipantsDto',
    PinChatRequest: 'PinChatDto',
    PinMessageRequest: 'PinMessageDto',
    ReactMessageRequest: 'ReactMessageDto',
    ReplyMessageRequest: 'ReplyMessageDto',
    RequestPairingCodeRequest: 'RequestPairingCodeDto',
    SendAudioRequest: 'SendAudioMessageDto',
    SendBulkRequest: 'SendBulkMessageDto',
    SendChatStateRequest: 'SendChatStateDto',
    SendContactRequest: 'SendContactDto',
    SendImageStatusRequest: 'SendImageStatusDto',
    SendLocationRequest: 'SendLocationDto',
    SendMediaRequest: 'SendMediaMessageDto',
    SendPollRequest: 'SendPollDto',
    SendProductRequest: 'SendProductDto',
    SendTemplateRequest: 'SendTemplateMessageDto',
    SendTextRequest: 'SendTextMessageDto',
    SendTextStatusRequest: 'SendTextStatusDto',
    SendVideoStatusRequest: 'SendVideoStatusDto',
    SendVoiceStatusRequest: 'SendVoiceStatusDto',
    SetGroupPictureRequest: 'SetGroupPictureDto',
    SetOwnPresenceRequest: 'SetOwnPresenceDto',
    SetProfileNameRequest: 'SetProfileNameDto',
    SetProfilePictureRequest: 'SetProfilePictureDto',
    SetProfileStatusRequest: 'SetProfileStatusDto',
    StarMessageRequest: 'StarMessageDto',
    TransferChannelOwnershipRequest: 'TransferChannelOwnershipDto',
    UnpinMessageRequest: 'UnpinMessageDto',
    UpdateSessionConfigRequest: 'UpdateSessionConfigDto',
    UpsertContactRequest: 'UpsertContactDto',
    UpsertLabelRequest: 'UpsertLabelDto',
    VotePollRequest: 'VotePollDto',
    WebhookFilterCondition: 'WebhookFilterConditionDto',
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
  'sdk/javascript/src/types.ts': 78,
  'dashboard/src/services/api.ts': 20,
  'sdk/python/openwa/types.py': 23,
  'sdk/go': 25,
  'sdk/java': 25,
};

/** Known drift, deliberately not gated yet — each line is a to-adjudicate follow-up. */
const EXCLUDED = {
  'dashboard/src/services/api.ts': {
    Session:
      'BY DESIGN, not drift: the wire always carries engineLoaded, but this client clears it to "unknown" after a websocket status event so the action helpers fall back to the status set — the type models client state, not the wire',
  },
};

/** Python client pairs (TypedDict classes in openwa/types.py). */
const PYTHON_MAPPING = {
  AccountRestriction: 'AccountRestrictionDto',
  BatchMessageResult: 'BatchMessageResultDto',
  BatchProgress: 'BatchProgressDto',
  BatchStatusResponse: 'BatchStatusResponseDto',
  BulkMessageContent: 'BulkMessageContentDto',
  BulkMessageItem: 'BulkMessageItemDto',
  BulkMessageResponse: 'BulkMessageResponseDto',
  CallLinkResponse: 'CallLinkResponseDto',
  ChatSummary: 'ChatSummaryDto',
  GroupInfo: 'GroupInfoDto',
  GroupJoinInfo: 'GroupJoinInfoDto',
  GroupParticipant: 'GroupParticipantDto',
  GroupSummary: 'GroupSummaryDto',
  MessageListResponse: 'MessageListResponseDto',
  MessageRecord: 'MessageListItemDto',
  MessageResponse: 'MessageResponseDto',
  PairingCodeResponse: 'PairingCodeResponseDto',
  ParticipantPresence: 'ParticipantPresenceDto',
  ProfilePictureResponse: 'ProfilePictureResponseDto',
  ProfilePicturesResponse: 'ProfilePicturesResponseDto',
  SessionResponse: 'SessionResponseDto',
  StatusResult: 'StatusResultDto',
  WebhookResponse: 'WebhookResponseDto',
};

/** Go client pairs (wire structs across types_*.go). */
const GO_MAPPING = {
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
  MessageRecord: 'MessageListItemDto',
  MessageResponse: 'MessageResponseDto',
  PairingCodeResponse: 'PairingCodeResponseDto',
  ParticipantPresence: 'ParticipantPresenceDto',
  ProfilePictureResponse: 'ProfilePictureResponseDto',
  ProfilePicturesResponse: 'ProfilePicturesResponseDto',
  SearchHit: 'SearchHitDto',
  SessionResponse: 'SessionResponseDto',
  StatusResult: 'StatusResultDto',
  WebhookResponse: 'WebhookResponseDto',
};

/** Java client pairs (record components in model/*.java). */
const JAVA_MAPPING = {
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
  MessageRecord: 'MessageListItemDto',
  MessageResponse: 'MessageResponseDto',
  PairingCodeResponse: 'PairingCodeResponseDto',
  ParticipantPresence: 'ParticipantPresenceDto',
  ProfilePictureResponse: 'ProfilePictureResponseDto',
  ProfilePicturesResponse: 'ProfilePicturesResponseDto',
  SearchHit: 'SearchHitDto',
  SessionResponse: 'SessionResponseDto',
  StatusResult: 'StatusResultDto',
  WebhookResponse: 'WebhookResponseDto',
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

/** Sort enum members the same way on both sides: numerically when every member is numeric, else
 *  lexicographically. The two token builders previously both used default .sort() (lexicographic),
 *  which ordered 10 before 2 - consistent by accident, and unable to recognize unquoted numeric
 *  unions in hand types at all, leaving numeric enums ungated.
 */
const sortEnumMembers = members =>
  members.every(m => /^-?\d+(\.\d+)?$/.test(m))
    ? members.slice().sort((a, b) => Number(a) - Number(b))
    : members.slice().sort();

export function handToken(text, types, depth = 0) {
  const t = text.trim().replace(/;$/, '');
  if (t.endsWith('[]')) return `array<${handToken(t.slice(0, -2), types, depth)}>`;
  if (/^(string|number|boolean|unknown|any)$/.test(t)) return t;
  const literals = [...t.matchAll(/'([^']+)'/g)].map(m => m[1]);
  // Unquoted numeric literals (font enums like 0|1|2|6) count too.
  const numerics = [...t.matchAll(/(?<![\w.'])(-?\d+(?:\.\d+)?)(?![\w.])/g)].map(m => m[1]);
  if (literals.length && literals.length === t.split('|').length) return `enum(${sortEnumMembers(literals).join(',')})`;
  if (numerics.length && numerics.length === t.split('|').length) return `enum(${sortEnumMembers(numerics).join(',')})`;
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
  if (node.enum) return `enum(${sortEnumMembers(node.enum.map(String)).join(',')})`;
  if (node.type === 'array') return `array<${schemaToken(node.items, schemas, depth)}>`;
  if (node.anyOf || node.oneOf) {
    const parts = (node.anyOf ?? node.oneOf).map(n => schemaToken(n, schemas, depth + 1));
    const nullable = parts.includes('null');
    const rest = parts.filter(p => p !== 'null').filter(p => p !== 'any' || !nullable);
    if (nullable && rest.length === 1) return `${rest[0]}|null`;
    return `union(${rest.sort().join(',')})`;
  }
  if (node.allOf) {
    // OpenAPI 3.0 composes class-typed fields (and ref+nullable pairs) as allOf members — merge
    // the members' object tokens into one (later members win, matching composition semantics).
    const merged = Object.assign({}, ...node.allOf.map(n => parseObjectToken(schemaToken(n, schemas, depth + 1))));
    return `object(${Object.entries(merged)
      .map(([f, v]) => `${f}${v.optional ? '?' : ''}:${v.token}`)
      .sort()
      .join(',')})`;
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
export function comparePair(handName, handMembers, schemaName, schema, schemas, compareOptionality = true) {
  const diffs = [];
  const schemaFields = parseObjectToken(schemaToken(schema, schemas));
  for (const [field, handInfo] of Object.entries(handMembers)) {
    const sField = schemaFields[field];
    if (!sField) {
      diffs.push(`hand has "${field}" — contract does not`);
      continue;
    }
    if (compareOptionality && handInfo.optional !== sField.optional) {
      diffs.push(
        `"${field}": hand ${handInfo.optional ? 'optional' : 'required'}, contract ${sField.optional ? 'optional' : 'required'}`,
      );
      continue;
    }
    if (isSimpleToken(sField.token)) {
      let hand = isSimpleToken(handInfo.token)
        ? handInfo.token
        : handToken(handInfo.token, { [handName]: handMembers });
      let contract = sField.token;
      if (!compareOptionality) {
        // Java (the only such client) cannot express non-null references — strip null arms on
        // BOTH sides so nullability does not read as drift there; enums and kinds still compare.
        hand = hand.replace(/\|null$/, '');
        contract = contract.replace(/\|null$/, '');
      }
      const absorbs = handInfo.absorbsNull && contract === `${hand}|null`;
      if (hand !== contract && !absorbs && isSimpleToken(hand)) {
        diffs.push(`"${field}": hand ${hand}, contract ${contract}`);
      }
    }
  }
  for (const field of Object.keys(schemaFields)) {
    if (!(field in handMembers)) diffs.push(`contract has "${field}" — hand does not`);
  }
  return diffs;
}

// ── per-language hand parsers (same member-map contract as parseHandTypes) ──

/**
 * Python (sdk/python/openwa/types.py): TypedDict classes with `total=False` optionality,
 * `Optional[X]`/`X | None` null unions, `List[X]`, inline and aliased `Literal[...]` enums, and
 * TypedDict inheritance (the parent's own total flag governs its members).
 */
export function parsePythonTypes(source) {
  // Join continuation lines inside unclosed brackets so multi-line Literal[...] aliases and
  // annotations parse as one token (a truncated `Literal[` is worse than no token).
  const joined = [];
  let carry = '';
  for (const line of source.split('\n')) {
    carry = carry ? carry + ' ' + line.trim() : line;
    let depth = 0;
    for (const ch of carry) {
      if (ch === '[' || ch === '{' || ch === '(') depth++;
      else if (ch === ']' || ch === '}' || ch === ')') depth--;
    }
    if (depth <= 0) {
      joined.push(carry);
      carry = '';
    }
  }
  if (carry) joined.push(carry);
  source = joined.join('\n');
  const dicts = {};
  const parents = {};
  const optionalAll = new Set();
  // Functional TypedDict form (`Name = TypedDict("Name", { ... }, total=False)`): the only way to
  // declare a field named `from` (a Python keyword), so MessageRecord uses it. Normalise each into
  // the same shape the class-form parse below produces, so both forms map identically.
  for (const m of source.matchAll(/(\w+) = TypedDict\(\s*"\w+",\s*\{([\s\S]*?)\}\s*,?\s*(total=False)?\s*,?\s*\)/g)) {
    const [, name, body, totalFalse] = m;
    // Same member shape parsePythonMembers produces, so the downstream token merge treats both
    // forms identically. Optional[...] unwraps to the inner type and marks the member optional.
    const members = {};
    // The bracket-joining preprocessing above collapses the dict to ONE line, so fields are
    // delimited by the next `"key":` (lookahead), not by newlines.
    for (const f of body.matchAll(/"([^"]+)"\s*:\s*(".*?"|[^,]+?)(?=\s*,?\s*(?:\}|$)|\s*,\s*"[^"]+"\s*:)/g)) {
      // Optional[...] stays verbatim: the comparator reads it as `T|null` (nullability), distinct
      // from optionality. Only total=False / NotRequired mark a member optional.
      let token = f[2].trim().replace(/,$/, '');
      let optional = !!totalFalse;
      const notReq = token.match(/^NotRequired\[([\s\S]+)\]$/);
      if (notReq) {
        token = notReq[1].trim();
        optional = true;
      }
      members[f[1]] = { optional, token, __py: true };
    }
    dicts[name] = members;
  }
  const blocks = [...source.matchAll(/class (\w+)\(([^)]*)\):\n([\s\S]*?)(?=\nclass |\n[A-Z]\w+ = |\n*$)/g)];
  // A subclass never re-mentions TypedDict — accept any class whose base chain reaches one
  // (fixpoint: a class is rooted when a base is itself a rooted class).
  const basesOf = Object.fromEntries(
    blocks.map(([, n, b]) => [
      n,
      b
        .split(',')
        .map(x => x.trim())
        .filter(x => x && x !== 'TypedDict' && !x.includes('=')),
    ]),
  );
  let rooted = new Set(blocks.filter(([, , b]) => /(^|\W)TypedDict(\W|$)/.test(b)).map(([, n]) => n));
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of Object.keys(basesOf)) {
      if (rooted.has(name)) continue;
      if (basesOf[name].some(b => rooted.has(b))) {
        rooted.add(name);
        grew = true;
      }
    }
  }
  for (const [, name, bases, body] of blocks) {
    if (!rooted.has(name)) continue;
    if (/total=False/.test(bases)) optionalAll.add(name);
    if (basesOf[name].length) parents[name] = basesOf[name];
    dicts[name] = parsePythonMembers(body);
  }

  const aliases = {};
  for (const [, name, rhs] of source.matchAll(/^([A-Z]\w+) = (.+)$/gm)) aliases[name] = rhs.trim();
  const resolve = (name, depth = 0) => {
    if (depth >= 4) return 'object';
    if (dicts[name]) return pythonObjectToken(dicts[name], resolve, depth);
    if (aliases[name] !== undefined) return pythonToken(aliases[name], resolve, depth);
    return name;
  };
  const merged = {};
  for (const name of Object.keys(dicts)) {
    merged[name] = {};
    for (const base of parents[name] ?? []) Object.assign(merged[name], dicts[base] ?? {});
    Object.assign(merged[name], dicts[name]);
  }
  // total=False marks the class's OWN members optional; inherited members keep the parent's flag.
  for (const [name, members] of Object.entries(merged)) {
    for (const [field, info] of Object.entries(members)) {
      if (dicts[name] && dicts[name][field] && dicts[name][field].__py) {
        if (optionalAll.has(name)) info.optional = true;
        info.token = pythonToken(info.token, resolve);
      }
    }
  }
  return merged;
}

function parsePythonMembers(body) {
  const members = {};
  let inDoc = false;
  for (const rawLine of body.split('\n')) {
    const t = rawLine.trim();
    const quotes = (rawLine.match(/"""/g) ?? []).length;
    if (quotes >= 2 && !inDoc) continue; // one-line docstring
    if (quotes === 1) {
      inDoc = !inDoc;
      continue;
    }
    if (inDoc || !t || t.startsWith('#')) continue;
    const m = t.match(/^(\w+)\s*:\s*(.+)$/);
    if (!m) continue;
    let optional = false;
    let typeText = m[2];
    const notReq = typeText.match(/^NotRequired\[(.+)\]$/s);
    if (notReq) {
      optional = true;
      typeText = notReq[1];
    }
    members[m[1]] = { optional, token: typeText.replace(/,$/, '').trim(), __py: true };
  }
  return members;
}

function pythonObjectToken(members, resolve, depth) {
  const parts = [];
  for (const [f, v] of Object.entries(members)) {
    parts.push(`${f}${v.optional ? '?' : ''}:${pythonToken(v.token, resolve, depth + 1)}`);
  }
  return `object(${parts.sort().join(',')})`;
}

function pythonToken(text, resolve, depth = 0) {
  let t = text.trim();
  if (t.endsWith(',')) t = t.slice(0, -1).trim();
  if (depth >= 4) return 'object';
  let nullable = false;
  if (/\|\s*None$/.test(t) || /^Optional\[/.test(t)) {
    nullable = true;
    t = t
      .replace(/^Optional\[/, '')
      .replace(/\s*\|\s*None$/, '')
      .replace(/\]$/, '')
      .trim();
  }
  const base = (() => {
    if (t === 'str') return 'string';
    if (t === 'int' || t === 'float') return 'number';
    if (t === 'bool') return 'boolean';
    if (t === 'Any') return 'any';
    const lit = t.match(/^Literal\[(.+)\]$/s);
    if (lit) {
      const vals = [...lit[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
      if (vals.length) return `enum(${vals.slice().sort().join(',')})`;
    }
    const lst = t.match(/^(?:List|list)\[(.+)\]$/s);
    if (lst) return `array<${pythonToken(lst[1], resolve, depth + 1)}>`;
    if (/^(?:Dict|dict)\[/.test(t)) return 'dict';
    if (/^(?:Union|union)\[/.test(t)) {
      const inner = t.slice(t.indexOf('[') + 1, -1);
      const parts = inner
        .split(',')
        .map(x => pythonToken(x, resolve, depth + 1))
        .sort();
      return `union(${parts.join(',')})`;
    }
    if (/^[A-Z]\w*$/.test(t)) return resolve ? resolve(t, depth) : t;
    return t;
  })();
  return nullable ? `${base}|null` : base;
}

/**
 * Go (sdk/go/types_*.go): struct fields with json tags — pointer/omitempty/slice ⇒ optional,
 * pointer ⇒ token|null; scalar defined types resolve to their underlying kind, and const blocks
 * grouped per defined type produce enum tokens.
 */
export function parseGoTypes(sources) {
  const structs = {};
  const scalarAliases = {};
  const constGroups = {};
  const kindMap = { string: 'string', int: 'number', int64: 'number', float64: 'number', bool: 'boolean', any: 'any' };

  for (const source of sources) {
    for (const [, name, underlying] of source.matchAll(/^type (\w+) (string|int|int64|float64|bool|any)$/gm)) {
      scalarAliases[name] = kindMap[underlying];
    }
    for (const block of source.matchAll(/type (\w+) struct \{([\s\S]*?)\n\}/g)) {
      const members = {};
      for (const line of block[2].split('\n')) {
        const m = line.match(/^\s*[A-Z]\w*\s+([\w[\]*.]+)\s+`json:"([^"]+)"`/);
        if (!m) continue;
        const json = m[2].split(',');
        const field = json[0];
        if (!field || field === '-') continue;
        const fullType = m[1];
        const omitempty = json.includes('omitempty');
        const ptr = fullType.startsWith('*');
        // omitempty is what drops a key on the wire — THAT is optionality. A bare pointer (no
        // omitempty) serializes null: a REQUIRED nullable field, not an optional one. A bare
        // []T is a required array (slices are nil-able in Go but not absent on the wire).
        members[field] = { optional: omitempty, token: '', __struct: fullType, __ptr: ptr, __omit: omitempty };
      }
      structs[block[1]] = members;
    }
    for (const cblock of source.matchAll(/const \(([\s\S]*?)\n\)/g)) {
      for (const line of cblock[1].split('\n')) {
        // gofmt pads name/type with multiple spaces — \s+ on both sides of the type.
        const m = line.match(/^\s*\w+\s+(\w+)\s+=\s+["']([^"']+)["']/);
        if (m) (constGroups[m[1]] ??= []).push(m[2]);
      }
    }
  }

  // defined scalar types whose consts exist become enums
  for (const [tname, vals] of Object.entries(constGroups)) {
    if (scalarAliases[tname]) scalarAliases[tname] = `enum(${[...new Set(vals)].sort().join(',')})`;
  }

  const expand = (typeText, depth = 0) => {
    if (depth >= 4) return 'object';
    if (typeText.startsWith('map[')) return 'dict';
    if (typeText.startsWith('[]')) return `array<${expand(typeText.slice(2), depth + 1)}>`;
    if (typeText.startsWith('*')) return `${expand(typeText.slice(1), depth + 1)}|null`;
    if (structs[typeText]) {
      const parts = Object.entries(structs[typeText]).map(([f, v]) => `${f}${v.optional ? '?' : ''}:${v.token}`);
      return `object(${parts.sort().join(',')})`;
    }
    return scalarAliases[typeText] ?? kindMap[typeText] ?? typeText;
  };

  for (const members of Object.values(structs)) {
    for (const v of Object.values(members)) {
      v.token = expand(v.__struct);
      // pointer+omitempty is "absent-dominant": JSON null and a missing key are indistinguishable
      // through *T with omitempty, so the null arm is dropped and the field flagged absorbsNull —
      // a nil *T covers both an absent key and an explicit null, so it also conforms to an
      // optional-nullable contract, which Go cannot spell distinctly.
      if (v.__ptr && v.__omit) {
        v.token = v.token.replace(/\|null$/, '');
        v.absorbsNull = true;
      }
    }
  }
  return structs;
}

/**
 * Java (sdk/java/.../model/*.java): record components — the object model cannot express
 * requiredness (every reference is nullable), so these pairs compare presence + type tokens only
 * (the client config sets compareOptionality=false).
 */
export function parseJavaTypes(sources) {
  const records = {};
  const primMap = {
    String: 'string',
    int: 'number',
    long: 'number',
    double: 'number',
    float: 'number',
    boolean: 'boolean',
    Integer: 'number',
    Long: 'number',
    Boolean: 'boolean',
    JsonObject: 'any',
    Object: 'any',
    BigDecimal: 'number',
    Instant: 'string',
    LocalDate: 'string',
  };
  for (const raw of sources) {
    // Javadoc BETWEEN record components breaks comma-splitting — strip comments first.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of source.matchAll(/record (\w+)\(([^)]*)\)/g)) {
      const members = {};
      for (const comp of m[2].split(',')) {
        const cm = comp.trim().match(/^(?:final\s+)?([\w<>,.\[\]\s]+?)\s+(\w+)$/);
        if (!cm) continue;
        members[cm[2]] = { optional: true, token: cm[1].trim(), __java: cm[1].trim() };
      }
      records[m[1]] = members;
    }
  }
  const expand = (t, depth = 0) => {
    if (depth >= 4) return 'object';
    const lst = t.match(/^List<(.+)>$/);
    if (lst) return `array<${expand(lst[1], depth + 1)}>`;
    if (/^Map</.test(t)) return 'dict';
    if (primMap[t]) return primMap[t];
    const short = t.split('.').pop();
    if (records[short]) {
      const parts = Object.entries(records[short]).map(([f, v]) => `${f}:${expand(v.__java, depth + 1)}`);
      return `object(${parts.sort().join(',')})`;
    }
    return t;
  };
  for (const members of Object.values(records)) {
    for (const v of Object.values(members)) v.token = expand(v.__java);
  }
  return records;
}

// ── CLI driver ──

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) {
  const openapi = JSON.parse(readFileSync(`${REPO_ROOT}openapi.json`, 'utf8'));
  const schemas = openapi.components.schemas;

  /**
   * Five HTTP clients, one gate. The two TypeScript trees parse with parseHandTypes; Python, Go
   * and Java each get the parser for their declaration style. PHP is deliberately absent: its
   * client returns untyped array<string,mixed> throughout — there is no types layer to conform
   * (the same reason check-sdk-events exempts it).
   *
   * Java sets compareOptionality=false: record components cannot express requiredness (every
   * reference is nullable), so those pairs verify field presence and type tokens only.
   */
  const goSources = () =>
    readdirSync(`${REPO_ROOT}sdk/go`)
      .filter(f => f.endsWith('.go') && !f.endsWith('_test.go'))
      .map(f => readFileSync(`${REPO_ROOT}sdk/go/${f}`, 'utf8'));
  const javaSources = () =>
    readdirSync(`${REPO_ROOT}sdk/java/src/main/java/com/rmyndharis/openwa/model`)
      .filter(f => f.endsWith('.java'))
      .map(f => readFileSync(`${REPO_ROOT}sdk/java/src/main/java/com/rmyndharis/openwa/model/${f}`, 'utf8'));

  const CLIENTS = [
    ...Object.entries(MAPPINGS).map(([file, mapping]) => ({
      label: file,
      load: () => parseHandTypes(readFileSync(`${REPO_ROOT}${file}`, 'utf8')),
      mapping,
      excluded: EXCLUDED[file] ?? {},
      floor: MINIMUM_MAPPED[file],
      compareOptionality: true,
    })),
    {
      label: 'sdk/python/openwa/types.py',
      load: () => parsePythonTypes(readFileSync(`${REPO_ROOT}sdk/python/openwa/types.py`, 'utf8')),
      mapping: PYTHON_MAPPING,
      excluded: EXCLUDED['sdk/python/openwa/types.py'] ?? {},
      floor: MINIMUM_MAPPED['sdk/python/openwa/types.py'],
      compareOptionality: true,
    },
    {
      label: 'sdk/go (types_*.go)',
      load: () => parseGoTypes(goSources()),
      mapping: GO_MAPPING,
      excluded: EXCLUDED['sdk/go'] ?? {},
      floor: MINIMUM_MAPPED['sdk/go'],
      compareOptionality: true,
    },
    {
      label: 'sdk/java (model/*.java)',
      load: () => parseJavaTypes(javaSources()),
      mapping: JAVA_MAPPING,
      excluded: EXCLUDED['sdk/java'] ?? {},
      floor: MINIMUM_MAPPED['sdk/java'],
      compareOptionality: false,
    },
  ];

  let failures = 0;
  let compared = 0;

  for (const client of CLIENTS) {
    const handTypes = client.load();
    let fileCompared = 0;
    const fileResults = [];

    for (const [handName, schemaName] of Object.entries(client.mapping)) {
      if (client.excluded[handName]) continue;
      const hand = handTypes[handName];
      const schema = schemas[schemaName];
      if (!hand) {
        fileResults.push(`  MISSING hand type ${handName} (declared in mapping but not found in ${client.label})`);
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
      const diffs = comparePair(handName, hand, schemaName, schema, schemas, client.compareOptionality);
      if (diffs.length) {
        fileResults.push(`  ${handName} ↔ ${schemaName}:`, ...diffs.map(d => `    ${d}`));
        failures++;
      }
    }

    if (Object.keys(client.mapping).length < client.floor) {
      fileResults.push(
        `  only ${Object.keys(client.mapping).length} mapped pairs for ${client.label} (floor ${client.floor}) — entries were dropped`,
      );
      failures++;
    }
    if (fileCompared < 8) {
      fileResults.push(`  only ${fileCompared} pairs compared for ${client.label} — vacuous-pass guard`);
      failures++;
    }
    console.log(`${client.label}: ${fileCompared} pairs compared, ${fileResults.length ? 'FAILURES' : 'all conform'}`);
    for (const line of fileResults) console.log(line);
    const excludedCount = Object.keys(client.excluded).length;
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
