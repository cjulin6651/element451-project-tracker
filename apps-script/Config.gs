/**
 * Project Tracker — configuration
 * Central IDs, tab names, and schema. Nothing here does work.
 */

const CONFIG = {
  // REQUIRED: customize these values before running setup().
  INSTITUTION_NAME: 'YOUR INSTITUTION',
  ALLOWED_VIEWER_DOMAINS: ['example.edu'],
  BRAND_LOGO_URL: 'https://example.com/project-tracker-icon-256.png',
  BRAND_FAVICON_URL: 'https://example.com/project-tracker-icon-64.png',
  // Optional external person/student identifier slots. The internal keys `spark`
  // and `school` are legacy implementation slots only; they are NOT required
  // institution terminology. Keep both disabled until an institution explicitly
  // maps a slot to an identifier it actually uses. User-facing labels come from
  // `label`, and automatic unlabeled-text recognition requires `tokenPattern`.
  ADDITIONAL_STUDENT_ID_TYPES: {
    spark: { enabled: false, label: 'Additional ID 1', mappingSlug: '', tokenPattern: '' },
    school: { enabled: false, label: 'Additional ID 2', mappingSlug: '', tokenPattern: '' }
  },
  DRIVE_ID: 'PASTE_SHARED_DRIVE_ID_HERE',
  TICKETS_FOLDER_ID: 'PASTE_TICKETS_FOLDER_ID_HERE',
  ARCHIVE_FOLDER_ID: 'PASTE_ARCHIVE_FOLDER_ID_HERE',

  SPREADSHEET_NAME: 'Project Tracker Data',
  TICKET_PREFIX: 'TKT-',
  TICKET_PAD: 4,

  MAX_TOTAL_INLINE_BYTES: 8 * 1024 * 1024,
  MAX_ATTACHMENT_FILE_BYTES: 7 * 1024 * 1024,
  RESOURCE_MAX_DEPTH: 3,
  CACHE_SECONDS: 21600,
  PRESENCE_CACHE_SECONDS: 120,
  PRESENCE_ACTIVE_MS: 45000,
  NOTIFICATION_CACHE_SECONDS: 45,
  NOTIFICATION_ARCHIVE_DAYS: 30,
  NOTIFICATION_RECENT_READ: 5,
  AGENT_CACHE_SECONDS: 60,
  LIST_PAGE_SIZE: 50,
  LINK_SEARCH_LIMIT: 10,
  THREAD_PREVIEW_REPLIES: 3,
  EMAIL_WATCH_POLL_HOURS: 1,
  EMAIL_STUDENT_NAME_MAX_LOOKUPS: 8,
  EMAIL_STUDENT_SEARCH_CACHE_SECONDS: 6 * 60 * 60,
  EMAIL_NOTE_MAX_CHARS: 90000,
  CHAT_CONTEXT_MESSAGE_LIMIT: 30,
  CHAT_SOURCE_CONVERSATION_LIMIT: 40,
  CHAT_RECENT_SOURCE_LIMIT: 5,
  CHAT_DIRECTORY_SEARCH_LIMIT: 8,
  CHAT_CONTEXT_CACHE_SECONDS: 20 * 60,
  CHAT_COMPLETION_POLL_HOURS: 1,
  CHAT_SERVICE_ACCOUNT_CACHE_SECONDS: 50 * 60,
  PRIORITY_MANAGER_EMAILS: [],
  LOCK_TIMEOUT_MS: 20000,
  WORKLOAD_STUDY_SNAPSHOT_HOUR: 2,
  WORKLOAD_STUDY_BASELINE_START: '',
  WORKLOAD_SIZE_WEIGHTS: { XS: 1, S: 2, M: 4, L: 7, XL: 10 }
};


function projectTrackerInstitutionName_() {
  return String(CONFIG.INSTITUTION_NAME || 'your institution').trim() || 'your institution';
}

function projectTrackerEmailAllowed_(email) {
  email = String(email || '').toLowerCase().trim();
  const domains = (CONFIG.ALLOWED_VIEWER_DOMAINS || []).map(function (d) {
    return String(d || '').toLowerCase().replace(/^@/, '').trim();
  }).filter(Boolean);
  if (!email || !domains.length) return false;
  return domains.some(function (domain) { return email.endsWith('@' + domain); });
}

function projectTrackerStudentIdentityConfig_(kind) {
  kind = String(kind || '').toLowerCase().trim();
  const all = CONFIG.ADDITIONAL_STUDENT_ID_TYPES || {};
  const raw = all[kind] || {};
  return {
    kind: kind,
    enabled: raw.enabled === true,
    label: String(raw.label || '').trim() || 'Additional ID',
    mappingSlug: String(raw.mappingSlug || '').trim(),
    tokenPattern: String(raw.tokenPattern || '').trim()
  };
}

function projectTrackerStudentIdentityEnabled_(kind) {
  return projectTrackerStudentIdentityConfig_(kind).enabled;
}

function projectTrackerStudentIdentityLabel_(kind) {
  return projectTrackerStudentIdentityConfig_(kind).label;
}

function projectTrackerStudentIdentityMappingSlug_(kind) {
  return projectTrackerStudentIdentityConfig_(kind).mappingSlug;
}

function projectTrackerStudentIdentityRegex_(kind, flags, anchored) {
  const cfg = projectTrackerStudentIdentityConfig_(kind);
  if (!cfg.enabled || !cfg.tokenPattern) return null;
  try {
    return new RegExp((anchored ? '^(?:' : '(?:') + cfg.tokenPattern + (anchored ? ')$' : ')'), flags || 'i');
  } catch (e) {
    throw new Error('The tokenPattern configured for ' + cfg.label + ' is not a valid regular expression source.');
  }
}


const TABS = {
  TICKETS: 'Tickets',
  ACTIVITY: 'Activity',
  LINKS: 'Links',
  AGENTS: 'Agents',
  TYPES: 'Types',
  DEPARTMENTS: 'Departments',
  SIZES: 'Sizes',
  META: 'Meta',
  NOTIFICATIONS: 'Notifications',
  WATCHES: 'Watches',
  RELATED_STUDENTS: 'RelatedStudents',
  RELATED_RESOURCES: 'RelatedResources',
  EMAIL_WATCHES: 'EmailWatches',
  CHAT_LINKS: 'ChatLinks',
  WORKLOAD_SNAPSHOTS: 'WorkloadSnapshots',
  TICKET_METRICS: 'TicketMetrics',
  TICKET_LIFECYCLE: 'TicketLifecycle'
};


const SCHEMA = {
  Tickets: [
    'ticket_id', 'title', 'description', 'type', 'department',
    'status', 'substatus', 'owners', 'size', 'progress',
    'created_by', 'created_at', 'updated_at', 'last_activity_at',
    'due_date', 'waiting_who', 'waiting_what', 'waiting_since',
    'drive_folder_id', 'halt_reason', 'halt_note', 'completed_at',
    'deleted', 'deleted_at',
    'high_priority', 'priority_by', 'priority_at',
    'description_markup'
  ],
  Activity: [
    'activity_id', 'ticket_id', 'timestamp', 'actor', 'kind', 'body', 'ref',
    'parent_activity_id', 'edited_at', 'deleted', 'deleted_at', 'body_markup'
  ],
  Links: ['link_id', 'ticket_a', 'ticket_b', 'relation', 'created_at'],
  Agents: ['email', 'display_name', 'role', 'active'],
  Types: ['type_name', 'default_size', 'sort_order', 'active'],
  Departments: ['dept_name', 'sort_order', 'active'],
  Sizes: ['code', 'label', 'time_guidance', 'sort_order'],
  Meta: ['key', 'value'],
  Notifications: [
    'notification_id', 'user_email', 'ticket_id', 'timestamp',
    'actor', 'kind', 'body', 'read_at', 'title', 'archived_at'
  ],
  Watches: [
    'watch_id', 'ticket_id', 'user_email',
    'on_complete', 'on_note', 'on_progress',
    'created_at', 'updated_at', 'chat_on_complete', 'chat_completion_notified_at'
  ],
  RelatedStudents: [
    'relation_id', 'ticket_id', 'element_id', 'first_name', 'last_name',
    'profile_url', 'source', 'added_by', 'created_at', 'removed', 'removed_at'
  ],
  RelatedResources: [
    'resource_id', 'ticket_id', 'resource_type', 'external_id', 'canonical_key',
    'name', 'url', 'drive_file_id', 'mime_type', 'parent_resource_id', 'depth',
    'sort_order', 'activity_id', 'visible_in_card', 'source', 'created_by',
    'created_at', 'updated_at', 'removed', 'removed_at', 'unresolved_name'
  ],
  EmailWatches: [
    'watch_id', 'ticket_id', 'thread_id', 'thread_url', 'subject', 'mailbox_user',
    'active', 'last_message_id', 'last_message_at', 'last_message_count',
    'created_by', 'created_at', 'updated_at'
  ],
  ChatLinks: [
    'chat_link_id', 'ticket_id', 'space_name', 'space_type', 'space_display_name',
    'thread_name', 'originator_email', 'participant_json', 'notify_on_complete',
    'complete_include_view_link', 'created_include_view_link', 'created_posted',
    'created_by', 'created_at', 'updated_at', 'completion_notified_at'
  ],
  WorkloadSnapshots: [
    'snapshot_key', 'snapshot_date', 'subject_key', 'subject_label', 'subject_type',
    'working_day', 'activity_count', 'first_activity_at', 'last_activity_at',
    'active_count', 'actionable_count', 'in_progress_count', 'up_next_count',
    'on_hold_count', 'wish_list_count', 'xs_count', 's_count', 'm_count', 'l_count', 'xl_count',
    'weighted_active_load', 'weighted_remaining_load', 'overdue_count', 'high_priority_count',
    'created_today_count', 'created_today_weight', 'completed_today_count', 'completed_today_weight',
    'net_ticket_flow', 'net_weight_flow', 'study_created_total', 'study_completed_total', 'study_net_total',
    'active_median_age_days', 'oldest_active_age_days', 'captured_at'
  ],
  TicketMetrics: [
    'ticket_id', 'created_at', 'completed_at', 'current_status', 'current_substatus',
    'creation_source', 'created_by', 'owners_at_creation', 'owners_at_completion', 'current_owners',
    'type_at_creation', 'type_at_completion', 'current_type',
    'size_at_creation', 'size_at_completion', 'current_size',
    'first_in_progress_at', 'total_on_hold_hours', 'cycle_hours', 'active_cycle_hours',
    'working_day_cycle_days', 'reopen_count', 'completion_count', 'historical_precision', 'last_calculated_at'
  ],
  TicketLifecycle: [
    'event_id', 'ticket_id', 'timestamp', 'actor', 'event_type',
    'from_status', 'to_status', 'from_substatus', 'to_substatus',
    'from_owners', 'to_owners', 'from_size', 'to_size', 'from_type', 'to_type',
    'creation_source', 'note'
  ]
};


/** Columns holding ISO date strings — forced to plain text so Sheets leaves them alone. */
const TEXT_COLUMNS = {
  Tickets: ['created_at', 'updated_at', 'last_activity_at', 'due_date', 'waiting_since', 'completed_at', 'deleted_at', 'priority_at'],
  Activity: ['timestamp', 'edited_at', 'deleted_at'],
  Links: ['created_at'],
  Notifications: ['timestamp', 'read_at', 'archived_at'],
  Watches: ['created_at', 'updated_at', 'chat_completion_notified_at'],
  RelatedStudents: ['created_at', 'removed_at'],
  RelatedResources: ['created_at', 'updated_at', 'removed_at'],
  EmailWatches: ['last_message_at', 'created_at', 'updated_at'],
  ChatLinks: ['created_at', 'updated_at', 'completion_notified_at'],
  WorkloadSnapshots: ['snapshot_date', 'first_activity_at', 'last_activity_at', 'captured_at'],
  TicketMetrics: ['created_at', 'completed_at', 'first_in_progress_at', 'last_calculated_at'],
  TicketLifecycle: ['timestamp']
};


const STATUS = {
  WISH: 'wish_list',
  UP_NEXT: 'up_next',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed'
};

const SUBSTATUS = {
  ON_HOLD: 'on_hold',
  DONE: 'done',
  HALTED: 'halted'
};

const HALT_REASONS = ['deprioritized', 'superseded', 'no_longer_needed', 'not_feasible', 'other'];

const ACTIVITY_KIND = {
  NOTE: 'note',
  EMAIL: 'email',
  CHAT: 'chat',
  FILE: 'file',
  LINK: 'link',
  CHANGE: 'change'
};


const SEED = {
  // Intentionally empty in the public template. setup() creates the Agents tab,
  // then the installer enters real users directly in that private spreadsheet.
  // This keeps staff contact information out of source code and AI prompts.
  agents: [],

  // These neutral defaults can be kept initially and edited later in the live Sheets tabs.
  types: [
    ['General Request', 'M', 10, true],
    ['Technical Issue', 'S', 20, true],
    ['Data / Reporting', 'M', 30, true],
    ['Enhancement', 'L', 40, true],
    ['Documentation', 'S', 50, true],
    ['Other', 'M', 60, true]
  ],

  departments: [
    ['General', 10, true],
    ['Other', 20, true]
  ],

  sizes: [
    ['XS', 'Quick', 'Under 30 minutes', 10],
    ['S', 'Small', '1 to 2 hours', 20],
    ['M', 'Medium', 'About a day', 30],
    ['L', 'Large', '2 to 5 days', 40],
    ['XL', 'Project', 'Multi-week', 50]
  ]
};
