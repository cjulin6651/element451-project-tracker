/**
 * Project Tracker — Google Workspace add-on surface for Google Chat.
 *
 * Cloud Console command IDs:
 *   101 — Create Project Tracker project (Quick command, opens dialog)
 *   102 — Add Chat to existing project (Quick command, opens dialog)
 *   103 — Log message to Project Tracker (Message action, Developer Preview)
 */

const PROJECT_TRACKER_CHAT_COMMANDS = {
  CREATE: 101,
  ADD_EXISTING: 102,
  MESSAGE_ACTION: 103
};

function chatCommon_(event) {
  return (event && (event.commonEventObject || event.common)) || {};
}

function chatParams_(event) {
  return chatCommon_(event).parameters || {};
}

function chatFormValues_(event, name) {
  const input = (chatCommon_(event).formInputs || {})[name] || {};
  return (input.stringInputs && input.stringInputs.value) || [];
}

function chatFormValue_(event, name) {
  const values = chatFormValues_(event, name);
  return values.length ? String(values[0] || '') : '';
}

function chatChecked_(event, name) {
  return chatFormValues_(event, name).length > 0;
}

function chatEscape_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chatShort_(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

function chatTime_(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'America/New_York', 'MMM d, h:mm a');
}

function chatMessageLabel_(message) {
  const who = message.sender && (message.sender.display_name || message.sender.email) || 'Chat user';
  let body = chatShort_(message.text || '', 105);
  if (!body && message.attachments && message.attachments.length) {
    body = message.attachments.length + ' attachment' + (message.attachments.length === 1 ? '' : 's');
  }
  return who + ' · ' + chatTime_(message.create_time) + ' — ' + (body || '(empty message)');
}

function chatOwnerItems_(selectedValue) {
  const me = String(Repo.me() || '').toLowerCase();
  const agents = Repo.activeAgents().filter(function (a) { return String(a.role || '').toLowerCase() === 'agent'; });
  const hasSelected = selectedValue !== undefined && selectedValue !== null && String(selectedValue) !== '';
  const items = agents.map(function (a, i) {
    return {
      text: String(a.display_name || a.email),
      value: String(a.email),
      selected: hasSelected ? String(a.email) === String(selectedValue) : (String(a.email || '').toLowerCase() === me || (!agents.some(function (x) { return String(x.email || '').toLowerCase() === me; }) && i === 0))
    };
  }).concat(agents.length > 1 ? [{
    text: 'All agents',
    value: agents.map(function (a) { return a.email; }).join(','),
    selected: hasSelected ? String(selectedValue) === agents.map(function (a) { return a.email; }).join(',') : false
  }] : []);
  return items;
}

function chatTypeItems_(selectedValue) {
  const rows = Repo.activeTypes();
  const hasSelected = selectedValue !== undefined && selectedValue !== null && String(selectedValue) !== '';
  return rows.map(function (t, i) {
    return { text: String(t.type_name), value: String(t.type_name), selected: hasSelected ? String(t.type_name) === String(selectedValue) : (t.type_name === 'Other' || (!rows.some(function (x) { return x.type_name === 'Other'; }) && i === 0)) };
  });
}

function chatDepartmentItems_(selectedValue) {
  const rows = Repo.activeDepartments();
  const value = selectedValue === '' ? '__NONE__' : selectedValue;
  const hasSelected = value !== undefined && value !== null;
  return [{ text: 'No department', value: '__NONE__', selected: hasSelected ? String(value) === '__NONE__' : true }].concat(rows.map(function (d) {
    return { text: String(d.dept_name), value: String(d.dept_name), selected: hasSelected ? String(d.dept_name) === String(value) : false };
  }));
}

function chatSizeItems_(selectedValue) {
  const hasSelected = selectedValue !== undefined && selectedValue !== null && String(selectedValue) !== '';
  return Repo.sizes().map(function (s) {
    return { text: s.code + ' · ' + s.label, value: String(s.code), selected: hasSelected ? String(s.code) === String(selectedValue) : s.code === 'M' };
  });
}

function chatDefaultTitle_(ctx) {
  const anchor = String(ctx.anchor_message_name || '');
  const rows = ctx.messages || [];
  const anchored = rows.filter(function (x) { return anchor && x.name === anchor; })[0] || null;
  function useful_(m) {
    const text = String(m && m.text || '').trim();
    if (!text) return false;
    // A pasted URL by itself is rarely a useful ticket title.
    if (/^https?:\/\/\S+$/i.test(text)) return false;
    return true;
  }
  const preferred = anchored && useful_(anchored) ? anchored : rows.filter(function (m) {
    return useful_(m) && !(m.sender && m.sender.email && String(m.sender.email).toLowerCase() === String(ctx.invoking_email || '').toLowerCase());
  })[0] || rows.filter(useful_)[0] || anchored || rows[0] || {};
  return chatShort_(preferred.text || 'New request from Google Chat', 100);
}

function chatMessageBodyHtml_(message) {
  let text = String(message.text || '').trim();
  if (!text && message.attachments && message.attachments.length) text = '(Attachment)';
  if (!text) text = '(Empty message)';
  return chatEscape_(chatShort_(text, 650)).replace(/\n/g, '<br>');
}

function chatMessageWidgets_(ctx) {
  const anchor = String(ctx.anchor_message_name || '');
  const me = String(ctx.invoking_email || '').toLowerCase();
  // Context messages arrive newest-first. Display oldest-first so the selector
  // reads like the actual Chat conversation.
  return (ctx.messages || []).slice().sort(function (a, b) {
    return String(a.create_time).localeCompare(String(b.create_time));
  }).map(function (m, i) {
    const senderEmail = String(m.sender && m.sender.email || '').toLowerCase();
    const sender = senderEmail && senderEmail === me ? 'You' : (m.sender && (m.sender.display_name || m.sender.email) || 'Chat user');
    const attachments = (m.attachments || []).map(function (a) { return a.content_name || 'Attachment'; }).filter(Boolean);
    return {
      decoratedText: {
        topLabel: sender + ' · ' + chatTime_(m.create_time),
        text: chatMessageBodyHtml_(m),
        bottomLabel: attachments.length ? ('Attachments: ' + chatShort_(attachments.join(', '), 120)) : '',
        wrapText: true,
        startIcon: { knownIcon: 'PERSON' },
        switchControl: {
          name: 'chat_message_' + i,
          value: String(m.name || ''),
          selected: anchor ? m.name === anchor : false,
          controlType: 'CHECK_BOX'
        }
      }
    };
  });
}

function chatMessageSections_(ctx, selectedNames, selectionProvided) {
  const anchor = String(ctx.anchor_message_name || '');
  const me = String(ctx.invoking_email || '').toLowerCase();
  const selected = {};
  (selectedNames || []).forEach(function (name) { selected[String(name)] = true; });
  const rows = (ctx.messages || []).slice().sort(function (a, b) {
    return String(a.create_time).localeCompare(String(b.create_time));
  });
  return rows.map(function (m, i) {
    const senderEmail = String(m.sender && m.sender.email || '').toLowerCase();
    const sender = senderEmail && senderEmail === me ? 'You' : (m.sender && (m.sender.display_name || m.sender.email) || 'Chat user');
    const attachments = (m.attachments || []).map(function (a) { return a.content_name || 'Attachment'; }).filter(Boolean);
    const isSelected = selectionProvided ? !!selected[String(m.name || '')] : (anchor ? m.name === anchor : false);
    return {
      header: sender + ' · ' + chatTime_(m.create_time),
      widgets: [{ decoratedText: {
        text: chatMessageBodyHtml_(m),
        bottomLabel: attachments.length ? ('📎 ' + chatShort_(attachments.join(', '), 140)) : '',
        wrapText: true,
        switchControl: {
          name: 'chat_message_' + i,
          value: String(m.name || ''),
          selected: isSelected,
          controlType: 'CHECK_BOX'
        }
      }}]
    };
  });
}

function chatSelectedMessageNames_(event) {
  const inputs = chatCommon_(event).formInputs || {};
  const out = [];
  Object.keys(inputs).forEach(function (key) {
    if (key.indexOf('chat_message_') !== 0) return;
    const values = chatFormValues_(event, key);
    values.forEach(function (v) { if (v) out.push(String(v)); });
  });
  // Backwards-compatible with the earlier single CHECK_BOX selector.
  chatFormValues_(event, 'chat_messages').forEach(function (v) { if (v) out.push(String(v)); });
  const seen = {};
  return out.filter(function (v) { if (seen[v]) return false; seen[v] = true; return true; });
}

function chatViewerItems_(ctx, selectedEmails) {
  const selected = {};
  (selectedEmails || []).forEach(function (email) { selected[String(email).toLowerCase()] = true; });
  const missing = {};
  ChatTicketing.missingViewerEmails(ctx).forEach(function (email) { missing[String(email).toLowerCase()] = true; });
  return (ctx.participants || []).filter(function (p) {
    return !p.is_me && p.email && missing[String(p.email).toLowerCase()];
  }).map(function (p) {
    return {
      text: 'Add ' + (p.display_name || p.email) + ' as a Project Tracker viewer',
      value: p.email,
      selected: !!selected[String(p.email).toLowerCase()]
    };
  });
}

function chatSharingWidgets_(ctx, draft) {
  draft = draft || {};
  const widgets = [
    { divider: {} },
    { textParagraph: { text: '<b>Optional sharing</b><br><font color="#777777">Nothing is posted back to this Chat unless you turn it on.</font>' }},
    { selectionInput: { name: 'announce_created', label: 'Creation message', type: 'CHECK_BOX', items: [
      { text: 'Tell this Chat that the request was logged as a project', value: 'yes', selected: !!draft.announce_created }
    ]}},
    { selectionInput: { name: 'created_view_link', label: 'Creation link', type: 'CHECK_BOX', items: [
      { text: 'Include a view-only Project Tracker link in the creation message', value: 'yes', selected: !!draft.created_view_link }
    ]}},
    { selectionInput: { name: 'notify_complete', label: 'Completion message', type: 'CHECK_BOX', items: [
      { text: 'Notify this Chat when the project is completed', value: 'yes', selected: !!draft.notify_complete }
    ]}},
    { selectionInput: { name: 'complete_view_link', label: 'Completion link', type: 'CHECK_BOX', items: [
      { text: 'Include the view-only Project Tracker link in the completion message', value: 'yes', selected: !!draft.complete_view_link }
    ]}}
  ];
  const viewerItems = chatViewerItems_(ctx, draft.grant_viewers || []);
  if (viewerItems.length) {
    widgets.push({ textParagraph: { text: '<font color="#777777">The following people are not currently in the Project Tracker Agents tab. Add them as viewers only if you plan to share the ticket link.</font>' }});
    widgets.push({ selectionInput: { name: 'grant_viewers', label: 'Viewer access', type: 'CHECK_BOX', items: viewerItems }});
  }
  return widgets;
}

function chatSourceCard_(mode, recent, liveLoaded) {
  recent = recent || [];
  const widgets = [
    { textParagraph: { text: '<b>Choose the Chat privately</b><br><font color="#777777">Run Project Tracker from this private DM. Pick a recent 1:1 Chat below, search for a coworker, or use a message link for a group chat.</font>' }}
  ];

  widgets.push({ buttonList: { buttons: [{
    text: liveLoaded ? 'REFRESH RECENT 1:1 CHATS' : 'LOAD RECENT 1:1 CHATS',
    onClick: { action: { function: 'chatRefreshRecentSources', parameters: [{ key: 'mode', value: mode }] }}
  }]}});
  widgets.push({ textParagraph: { text: '<font color="#777777">This reads your most recently active human-to-human DMs directly from Google Chat. You do not need to type the person first.</font>' }});

  if (recent.length) {
    widgets.push({ textParagraph: { text: '<b>Recent chats</b>' }});
    recent.slice(0, 6).forEach(function (r) {
      widgets.push({ buttonList: { buttons: [{
        text: 'USE ' + chatShort_(String(r.label || 'RECENT CHAT').toUpperCase(), 38),
        onClick: { action: { function: 'chatOpenRecentSource', parameters: [
          { key: 'mode', value: mode }, { key: 'spaceName', value: String(r.space_name || '') }
        ] }}
      }]}});
    });
  }

  widgets.push({ divider: {} });
  widgets.push({ textInput: {
    name: 'source_person_query',
    label: 'Coworker name or Workspace email',
    hintText: 'Example: Alex Morgan or alex@example.edu',
    type: 'SINGLE_LINE'
  }});
  widgets.push({ buttonList: { buttons: [{
    text: 'FIND 1:1 CHAT',
    onClick: { action: { function: 'chatFindDirectSource', parameters: [{ key: 'mode', value: mode }] }}
  }]}});
  widgets.push({ divider: {} });
  widgets.push({ textParagraph: { text: '<font color="#777777"><b>Group chat or exact conversation?</b> Use ⋮ → Copy message link on any message in that Chat and paste it below.</font>' }});
  widgets.push({ textInput: {
    name: 'source_message_link',
    label: 'Google Chat message link',
    hintText: 'Optional fallback for group chats',
    type: 'SINGLE_LINE'
  }});
  widgets.push({ buttonList: { buttons: [{
    text: 'OPEN FROM LINK',
    onClick: { action: { function: 'chatChooseSource', parameters: [{ key: 'mode', value: mode }] }}
  }]}});

  return {
    header: {
      title: mode === 'create' ? 'Create Project Tracker project' : 'Add Chat to existing project',
      subtitle: 'Private setup — choose the source conversation'
    },
    sections: [{ widgets: widgets }]
  };
}

function chatSourceDialog_(event, mode) {
  // Keep the command callback fast. Previously-used chats appear instantly;
  // the live Google Chat recency scan runs only when the user presses Load.
  return { action: { navigations: [{ pushCard: chatSourceCard_(mode, ChatTicketing.recentSources(), false) }] } };
}

function chatRefreshRecentSources(event) {
  try {
    const mode = String(chatParams_(event).mode || 'create');
    const recent = ChatTicketing.discoverRecentDirectSources(event);
    return { action: { navigations: [{ updateCard: chatSourceCard_(mode, recent, true) }] } };
  } catch (e) {
    Logger.log('Recent Chat refresh failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatOpenRecentSource(event) {
  try {
    const params = chatParams_(event);
    const mode = String(params.mode || 'create');
    const spaceName = String(params.spaceName || '').trim();
    if (!spaceName) return chatDialogError_('That recent Chat is no longer available.');
    const ctx = ChatTicketing.buildContextForSpace(spaceName, event, null);
    return chatDialog_(ctx, mode === 'existing' ? 'existing' : 'create');
  } catch (e) {
    Logger.log('Recent Chat quick-open failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatChooseRecentSource(event) {
  try {
    const mode = String(chatParams_(event).mode || 'create');
    const spaceName = chatFormValue_(event, 'recent_source');
    if (!spaceName) return chatDialogError_('Choose a recent Chat first.');
    const ctx = ChatTicketing.buildContextForSpace(spaceName, event, null);
    return chatDialog_(ctx, mode === 'existing' ? 'existing' : 'create');
  } catch (e) {
    Logger.log('Recent Chat selection failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatDirectoryChoiceDialog_(rows, mode) {
  return { action: { navigations: [{ pushCard: {
    header: { title: 'Choose coworker', subtitle: 'Open a private 1:1 Chat source' },
    sections: [{ widgets: [
      { selectionInput: {
        name: 'source_person_email', label: 'Matching people', type: 'RADIO_BUTTON',
        items: rows.map(function (p, i) { return { text: p.display_name + (p.email ? ' · ' + p.email : ''), value: p.email, selected: i === 0 }; })
      }},
      { buttonList: { buttons: [{ text: 'OPEN CHAT', onClick: { action: {
        function: 'chatChooseDirectoryPerson', parameters: [{ key: 'mode', value: mode }]
      }}}]}}
    ]}]
  }}]} };
}

function chatFindDirectSource(event) {
  try {
    const mode = String(chatParams_(event).mode || 'create');
    const query = chatFormValue_(event, 'source_person_query').trim();
    if (!query) return chatDialogError_('Enter a coworker name or Workspace email.');
    const rows = ChatTicketing.searchDirectoryPeople(query);
    if (!rows.length) return chatDialogError_('No matching coworker was found. Try their full name or email address.');
    if (rows.length === 1) {
      const ctx = ChatTicketing.buildContextForDirectMessage(rows[0].email, event);
      return chatDialog_(ctx, mode === 'existing' ? 'existing' : 'create');
    }
    return chatDirectoryChoiceDialog_(rows, mode);
  } catch (e) {
    Logger.log('Direct Chat search failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatChooseDirectoryPerson(event) {
  try {
    const mode = String(chatParams_(event).mode || 'create');
    const email = chatFormValue_(event, 'source_person_email');
    if (!email) return chatDialogError_('Choose a coworker.');
    const ctx = ChatTicketing.buildContextForDirectMessage(email, event);
    return chatDialog_(ctx, mode === 'existing' ? 'existing' : 'create');
  } catch (e) {
    Logger.log('Direct Chat selection failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatChooseSource(event) {
  try {
    const mode = String(chatParams_(event).mode || 'create');
    const sourceLink = chatFormValue_(event, 'source_message_link');
    if (!sourceLink) return chatDialogError_('Paste a Google Chat message link first.');
    const ctx = ChatTicketing.buildContextFromMessageLink(sourceLink, event);
    if (!ctx.messages || !ctx.messages.length) return chatDialogError_('No recent messages were found in that Chat conversation.');
    return chatDialog_(ctx, mode === 'existing' ? 'existing' : 'create');
  } catch (e) {
    Logger.log('Chat source selection failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatDialogDraftFromEvent_(event, mode) {
  const draft = {
    selection_provided: true,
    messages: chatSelectedMessageNames_(event),
    grant_viewers: chatFormValues_(event, 'grant_viewers'),
    announce_created: chatChecked_(event, 'announce_created'),
    created_view_link: chatChecked_(event, 'created_view_link'),
    notify_complete: chatChecked_(event, 'notify_complete'),
    complete_view_link: chatChecked_(event, 'complete_view_link')
  };
  if (mode === 'create') {
    draft.title = chatFormValue_(event, 'title');
    draft.description = chatFormValue_(event, 'description');
    draft.owners = chatFormValue_(event, 'owners');
    draft.type = chatFormValue_(event, 'type');
    draft.department = chatFormValue_(event, 'department');
    draft.size = chatFormValue_(event, 'size');
  } else {
    draft.ticket_query = chatFormValue_(event, 'ticket_query');
  }
  return draft;
}

function chatRangeControlSection_(ctx, mode, header) {
  const rangeParams = [{ key: 'contextId', value: ctx.context_id }, { key: 'mode', value: mode }];
  return { header: header || 'Message selection', widgets: [{ buttonList: { buttons: [
    { text: 'SELECT ALL', onClick: { action: { function: 'chatSelectAllMessages', parameters: rangeParams } } },
    { text: 'FILL BETWEEN CHECKED', onClick: { action: { function: 'chatFillBetweenMessages', parameters: rangeParams } } },
    { text: 'CLEAR', onClick: { action: { function: 'chatClearMessages', parameters: rangeParams } } }
  ]}}] };
}

function chatDialogCard_(ctx, mode, draft) {
  draft = draft || {};
  const setupWidgets = [];
  if (mode === 'create') {
    setupWidgets.push({ textInput: { name: 'title', label: 'Project title', type: 'SINGLE_LINE', value: draft.title !== undefined ? String(draft.title || '') : chatDefaultTitle_(ctx) } });
    setupWidgets.push({ textInput: {
      name: 'description',
      label: 'Project details',
      hintText: 'Optional background, request details, scope, or anything useful to keep with the project.',
      type: 'MULTIPLE_LINE',
      value: String(draft.description || '')
    }});
    setupWidgets.push({ selectionInput: { name: 'owners', label: 'Owner', type: 'DROPDOWN', items: chatOwnerItems_(draft.owners) } });
    setupWidgets.push({ selectionInput: { name: 'type', label: 'Type', type: 'DROPDOWN', items: chatTypeItems_(draft.type) } });
    setupWidgets.push({ selectionInput: { name: 'department', label: 'Department', type: 'DROPDOWN', items: chatDepartmentItems_(draft.department) } });
    setupWidgets.push({ selectionInput: { name: 'size', label: 'Size', type: 'DROPDOWN', items: chatSizeItems_(draft.size) } });
  } else {
    setupWidgets.push({ textInput: {
      name: 'ticket_query',
      label: 'Existing Project Tracker project',
      hintText: 'Ticket title, TKT-####, or Project Tracker URL',
      type: 'SINGLE_LINE',
      value: String(draft.ticket_query || '')
    }});
  }

  const conversationIntro = { header: 'Conversation', widgets: [
    { textParagraph: { text: '<b>Choose the messages to log</b><br><font color="#777777">Scroll the transcript below and check each Chat bubble you want. Google Chat does not expose the Shift key to add-on cards, so use <b>Fill between checked</b> for the same range-select behavior.</font>' }}
  ]};
  const topRangeControls = chatRangeControlSection_(ctx, mode, 'Selection controls');
  const bottomRangeControls = chatRangeControlSection_(ctx, mode, 'Selection controls');
  const conversationSections = chatMessageSections_(ctx, draft.messages || [], !!draft.selection_provided);
  const sharingWidgets = chatSharingWidgets_(ctx, draft);
  const submitAction = { action: {
    function: mode === 'create' ? 'chatSubmitCreate' : 'chatSubmitExisting',
    parameters: [{ key: 'contextId', value: ctx.context_id }]
  }};

  return {
    header: { title: mode === 'create' ? 'Create Project Tracker project' : 'Add Chat to existing project', subtitle: 'Select exactly what should be logged' },
    sections: [
      { header: mode === 'create' ? 'Project details' : 'Project', widgets: setupWidgets },
      conversationIntro,
      topRangeControls
    ].concat(conversationSections).concat([
      bottomRangeControls,
      { header: 'Sharing', widgets: sharingWidgets }
    ]),
    fixedFooter: {
      primaryButton: { text: mode === 'create' ? 'CREATE PROJECT' : 'ADD TO PROJECT', onClick: submitAction }
    }
  };
}

function chatDialog_(ctx, mode, draft) {
  if (mode === 'create' && ctx && ctx.context_id && !ctx.reserved_ticket_id) {
    ctx.reserved_ticket_id = ChatTicketing.reserveCreateTicketId(ctx.context_id);
  }
  return { action: { navigations: [{ pushCard: chatDialogCard_(ctx, mode, draft) }] } };
}

function chatUpdateMessageSelection_(event, action) {
  try {
    const params = chatParams_(event);
    const contextId = String(params.contextId || '');
    const mode = String(params.mode || 'create') === 'existing' ? 'existing' : 'create';
    const ctx = ChatTicketing.getContext(contextId, event);
    const draft = chatDialogDraftFromEvent_(event, mode);
    const rows = (ctx.messages || []).slice().sort(function (a, b) { return String(a.create_time).localeCompare(String(b.create_time)); });
    const names = rows.map(function (m) { return String(m.name || ''); }).filter(Boolean);
    if (action === 'all') draft.messages = names;
    else if (action === 'clear') draft.messages = [];
    else if (action === 'between') {
      const selected = {};
      (draft.messages || []).forEach(function (name) { selected[String(name)] = true; });
      const idx = names.map(function (name, i) { return selected[name] ? i : -1; }).filter(function (i) { return i >= 0; });
      if (idx.length >= 2) {
        const lo = Math.min.apply(null, idx), hi = Math.max.apply(null, idx);
        for (let i = lo; i <= hi; i++) selected[names[i]] = true;
        draft.messages = names.filter(function (name) { return selected[name]; });
      }
    }
    draft.selection_provided = true;
    return { action: { navigations: [{ updateCard: chatDialogCard_(ctx, mode, draft) }] } };
  } catch (e) {
    Logger.log('Chat message range selection failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatSelectAllMessages(event) { return chatUpdateMessageSelection_(event, 'all'); }
function chatFillBetweenMessages(event) { return chatUpdateMessageSelection_(event, 'between'); }
function chatClearMessages(event) { return chatUpdateMessageSelection_(event, 'clear'); }

function chatDialogError_(message) {
  // Chat's dialog chrome does not consistently expose an automatic back arrow,
  // so recoverable errors always include an explicit Back button.
  return { action: { navigations: [{ pushCard: {
    header: { title: 'Project Tracker could not continue' },
    sections: [{ widgets: [
      { textParagraph: { text: chatEscape_(String(message || 'Something went wrong.')) }},
      { buttonList: { buttons: [{
        text: 'BACK',
        onClick: { action: { function: 'chatDialogBack' } }
      }]}}
    ]}]
  }}]} };
}

function chatDialogBack() {
  return { action: { navigations: [{ popCard: {} }] } };
}

function chatDialogClose_(message) {
  return { action: {
    navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }],
    notification: { text: String(message || 'Done') }
  }};
}

function chatContextOpen_(event, mode) {
  try {
    const ctx = ChatTicketing.buildContext(event);
    return chatDialog_(ctx, mode);
  } catch (e) {
    Logger.log('Chat dialog failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatEventSpace_(event) {
  const chat = event && event.chat || {};
  const payload = chat.appCommandPayload || chat.buttonClickedPayload || chat.messagePayload || {};
  return payload.space || (payload.message && payload.message.space) || chat.space || event && event.space || {};
}

function chatCommandIsClearlyOutsidePrivateDm_(event) {
  let space = chatEventSpace_(event);
  if (space.singleUserBotDm === true) return false;
  let type = String(space.spaceType || space.type || '');
  let humans = Number(space.membershipCount && space.membershipCount.joinedDirectHumanUserCount || 0);
  // Some interaction payloads contain only a partial Space. Resolve that one
  // space when necessary so a human-to-human DM cannot accidentally pass the
  // privacy guard just because membershipCount was omitted from the event.
  if (type === 'DIRECT_MESSAGE' && space.singleUserBotDm !== true && !humans && space.name) {
    try {
      space = Chat.Spaces.get(String(space.name));
      if (space.singleUserBotDm === true) return false;
      type = String(space.spaceType || space.type || type);
      humans = Number(space.membershipCount && space.membershipCount.joinedDirectHumanUserCount || 0);
    } catch (ignore) {}
  }
  // Google can add the app to a human conversation before our command handler
  // executes. A human-human DM therefore still has two direct human members.
  if (humans >= 2) return true;
  if (type === 'GROUP_CHAT' || type === 'SPACE') return true;
  return false;
}

function chatCurrentSourceLabel_(event) {
  const space = chatEventSpace_(event) || {};
  const displayName = String(space.displayName || '').trim();
  if (displayName) return displayName;
  const type = String(space.spaceType || space.type || '');
  if (type === 'GROUP_CHAT' || type === 'SPACE') return 'this group chat';
  return 'this 1:1 chat';
}

function chatCurrentSourceDialog_(event, mode) {
  const sourceSpace = chatEventSpace_(event) || {};
  const sourceSpaceName = String(sourceSpace.name || '').trim();
  const label = chatCurrentSourceLabel_(event);
  return { action: { navigations: [{ pushCard: {
    header: {
      title: mode === 'existing' ? 'Add Chat to existing project' : 'Create Project Tracker project',
      subtitle: 'Use the conversation you opened this from'
    },
    sections: [{ widgets: [
      { textParagraph: { text: '<b>Log ' + chatEscape_(label) + '</b><br><font color="#777777">Project Tracker already knows which conversation you launched it from. No coworker search is required.</font>' }},
      { buttonList: { buttons: [{
        text: 'USE THIS CHAT',
        onClick: { action: { function: 'chatOpenCurrentSource', parameters: [
          { key: 'mode', value: mode },
          { key: 'sourceSpaceName', value: sourceSpaceName }
        ] } }
      }]}},
      { divider: {} },
      { textParagraph: { text: '<font color="#777777">Need a different conversation instead?</font>' }},
      { buttonList: { buttons: [{
        text: 'CHOOSE DIFFERENT CHAT',
        onClick: { action: { function: 'chatChooseDifferentSource', parameters: [{ key: 'mode', value: mode }] } }
      }]}}
    ]}]
  }}]} };
}

function chatOpenCurrentSource(event) {
  try {
    const params = chatParams_(event);
    const mode = String(params.mode || 'create');
    const sourceSpaceName = String(params.sourceSpaceName || '').trim();

    // Persist the source space from the original APP_COMMAND event into the
    // button action. A dialog button produces a new BUTTON_CLICKED event, and
    // that event's Chat space is not a reliable identifier for the conversation
    // where the command was originally invoked. This is especially important
    // for users who have never searched/cached the coworker before.
    const ctx = sourceSpaceName
      ? ChatTicketing.buildContextForSpace(sourceSpaceName, event, null, { reserve_create_ticket_id: mode !== 'existing' })
      : ChatTicketing.buildContext(event);
    return chatDialog_(ctx, mode === 'existing' ? 'existing' : 'create');
  } catch (e) {
    Logger.log('Current Chat source open failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatChooseDifferentSource(event) {
  const mode = String(chatParams_(event).mode || 'create');
  return { action: { navigations: [{ updateCard: chatSourceCard_(mode, ChatTicketing.recentSources(), false) }] } };
}

/**
 * Google Chat lifecycle/message trigger handlers.
 *
 * Keep these silent. Project Tracker can be launched from a human conversation
 * or from the user's DM with the app, but should not post an automatic message
 * merely because Google adds the app as part of an interaction.
 */
function onAddedToSpace(event) {
  return null;
}

function onRemovedFromSpace(event) {
  return null;
}

function onMessage(event) {
  return null;
}

function onAppCommand(event) {
  const payload = event && event.chat && event.chat.appCommandPayload || {};
  const meta = payload.appCommandMetadata || event && event.appCommandMetadata || {};
  const id = Number(meta.appCommandId || 0);

  if (id === PROJECT_TRACKER_CHAT_COMMANDS.CREATE || id === PROJECT_TRACKER_CHAT_COMMANDS.ADD_EXISTING) {
    const mode = id === PROJECT_TRACKER_CHAT_COMMANDS.ADD_EXISTING ? 'existing' : 'create';
    // When the command is invoked from a human 1:1/group conversation, make
    // that exact conversation the first-class source. This works even when the
    // coworker has never been searched for or cached in Project Tracker.
    if (chatCommandIsClearlyOutsidePrivateDm_(event)) return chatCurrentSourceDialog_(event, mode);
    // From the private Project Tracker DM, retain the recent/search/link picker.
    return chatSourceDialog_(event, mode);
  }

  if (id === PROJECT_TRACKER_CHAT_COMMANDS.MESSAGE_ACTION) return chatContextOpen_(event, 'create');
  return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: {
    text: 'Use the Project Tracker Create Project or Add to Project command.'
  }}}}};
}

function chatFormSnapshot_(event, contextId) {
  return {
    context_id: String(contextId || ''),
    messages: chatSelectedMessageNames_(event),
    grant_viewers: chatFormValues_(event, 'grant_viewers'),
    announce_created: chatChecked_(event, 'announce_created'),
    created_view_link: chatChecked_(event, 'created_view_link'),
    notify_complete: chatChecked_(event, 'notify_complete'),
    complete_view_link: chatChecked_(event, 'complete_view_link')
  };
}

function chatUnresolvedParticipants_(ctx) {
  return (ctx.participants || []).filter(function (p) { return !p.is_me && !p.email; });
}

function chatValidateSharing_(ctx, snapshot) {
  if (!snapshot.announce_created) snapshot.created_view_link = false;
  if (!snapshot.notify_complete) snapshot.complete_view_link = false;
  const wantsLink = snapshot.created_view_link || snapshot.complete_view_link;
  if (!wantsLink) return '';
  const unresolved = chatUnresolvedParticipants_(ctx);
  if (unresolved.length) {
    return 'Project Tracker could not resolve an email address for ' + unresolved.map(function (p) { return p.display_name || p.user_name || 'a Chat participant'; }).join(', ') + '. Turn off the view-only link or try again.';
  }
  const granted = {};
  snapshot.grant_viewers.forEach(function (email) { granted[String(email).toLowerCase()] = true; });
  const missing = ChatTicketing.missingViewerEmails(ctx).filter(function (email) { return !granted[String(email).toLowerCase()]; });
  if (missing.length) {
    return 'A shared ticket link would not open for ' + missing.join(', ') + '. Select their Viewer access checkbox or turn off the view-only link.';
  }
  return '';
}

function chatThreadForSelection_(ctx, messageNames) {
  const wanted = {};
  messageNames.forEach(function (n) { wanted[n] = true; });
  const threads = {};
  (ctx.messages || []).forEach(function (m) {
    if (wanted[m.name] && m.thread_name) threads[m.thread_name] = true;
  });
  const keys = Object.keys(threads);
  return keys.length === 1 ? keys[0] : '';
}

function chatPersistLinkAndShare_(ticket, ctx, snapshot) {
  // Queue optional sharing in User Properties only. This is deliberately much
  // cheaper than touching ChatLinks/Agents or posting to Chat inside the short
  // dialog callback. The hourly/manual sharing job materializes the queue later.
  const granted = {};
  (snapshot.grant_viewers || []).forEach(function (email) {
    granted[String(email || '').toLowerCase()] = true;
  });
  const queuedCtx = Object.assign({}, ctx, {
    participants: (ctx.participants || []).map(function (p) {
      const copy = Object.assign({}, p);
      if (copy.email && granted[String(copy.email).toLowerCase()]) copy.grant_viewer = true;
      return copy;
    })
  });
  const queued = ChatTicketing.queueSharingIntent(ticket.ticket_id, queuedCtx, {
    thread_name: chatThreadForSelection_(ctx, snapshot.messages),
    notify_on_complete: snapshot.notify_complete,
    complete_include_view_link: snapshot.complete_view_link,
    created_include_view_link: snapshot.created_view_link,
    announce_created: snapshot.announce_created
  });
  return {
    creation_queued: !!snapshot.announce_created && !!queued.queued,
    completion_queued: !!snapshot.notify_complete && !!queued.queued
  };
}

function chatSubmitCreate(event) {
  const started = Date.now();
  try {
    const contextId = chatParams_(event).contextId || '';
    const ctx = ChatTicketing.getContext(contextId, event);
    const snapshot = chatFormSnapshot_(event, contextId);
    Logger.log('Chat create checkpoint form + context: %sms', Date.now() - started);
    if (!snapshot.messages.length) return chatDialogError_('Select at least one Chat message.');
    // Viewer/link checks were already presented when the card was built. Do not
    // reread the Agents sheet here; the create callback must stay below Chat's
    // short practical response deadline. The queued sharing worker validates and
    // grants viewer access before it posts anything.
    if (!snapshot.announce_created) snapshot.created_view_link = false;
    if (!snapshot.notify_complete) snapshot.complete_view_link = false;

    const title = chatFormValue_(event, 'title').trim();
    if (!title) return chatDialogError_('Enter a project title.');
    const out = ChatTicketing.createTicketWithMessagesFast({
      title: title,
      owners: chatFormValue_(event, 'owners'),
      type: chatFormValue_(event, 'type'),
      department: chatFormValue_(event, 'department') === '__NONE__' ? '' : chatFormValue_(event, 'department'),
      size: chatFormValue_(event, 'size'),
      description: chatFormValue_(event, 'description').trim(),
      status: STATUS.IN_PROGRESS
    }, contextId, snapshot.messages);
    const ticket = out.ticket;
    Logger.log('Chat create checkpoint ticket + transcript written: %sms', Date.now() - started);

    let shareResult = { creation_queued: false, completion_queued: false };
    try {
      shareResult = chatPersistLinkAndShare_(ticket, ctx, snapshot);
    } catch (shareError) {
      Logger.log('Chat create sharing queue warning for %s: %s', ticket.ticket_id, shareError.message);
    }
    Logger.log('Chat create checkpoint sharing queued: %sms', Date.now() - started);

    let msg = ticket.ticket_id + ' created · ' + Number(out.imported || 0) + ' Chat message' + (Number(out.imported || 0) === 1 ? '' : 's') + ' logged.';
    if (shareResult.creation_queued) msg += ' The optional “request logged” Chat message is queued.';
    if (shareResult.completion_queued) msg += ' Completion notification is enabled.';
    Logger.log('Chat create complete in %sms', Date.now() - started);
    return chatDialogClose_(msg);
  } catch (e) {
    Logger.log('Create from Chat failed after %sms: %s\n%s', Date.now() - started, e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatDraftCacheKey_(id) { return 'pt_chat_existing_draft_' + id; }

function chatSaveExistingDraft_(draft) {
  const id = Utilities.getUuid();
  CacheService.getScriptCache().put(chatDraftCacheKey_(id), JSON.stringify(draft), Number(CONFIG.CHAT_CONTEXT_CACHE_SECONDS) || 1200);
  return id;
}

function chatGetExistingDraft_(id) {
  const raw = CacheService.getScriptCache().get(chatDraftCacheKey_(String(id || '')));
  if (!raw) throw new Error('This project selection expired. Open Project Tracker again from the Chat.');
  return JSON.parse(raw);
}

function chatExistingChoiceDialog_(rows, draftId) {
  return { action: { navigations: [{ pushCard: {
    header: { title: 'Choose a Project Tracker project', subtitle: 'More than one project matched your search' },
    sections: [{ widgets: [
      { selectionInput: {
        name: 'ticket_choice', label: 'Matching projects', type: 'RADIO_BUTTON',
        items: rows.map(function (t, i) { return { text: t.ticket_id + ' · ' + chatShort_(t.title, 80), value: t.ticket_id, selected: i === 0 }; })
      }},
      { buttonList: { buttons: [{ text: 'ADD CHAT', onClick: { action: {
        function: 'chatSubmitExistingChoice', parameters: [{ key: 'draftId', value: draftId }]
      }}}]}}
    ]}]
  }}]}};
}

function chatFinishExisting_(ticketId, draft) {
  const ctx = ChatTicketing.getContext(draft.context_id);
  const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
  if (!ticket) return chatDialogError_('That project no longer exists.');
  // Queue sharing first so the user's choices survive even if the later
  // transcript write approaches Chat's callback deadline.
  const shareResult = chatPersistLinkAndShare_(ticket, ctx, draft);
  const imported = ChatTicketing.importMessages(ticketId, draft.context_id, draft.messages || []);
  let msg = imported.imported + ' Chat message' + (imported.imported === 1 ? '' : 's') + ' added to ' + ticket.ticket_id + '.';
  if (imported.duplicateMessagesSkipped) msg += ' ' + imported.duplicateMessagesSkipped + ' duplicate' + (imported.duplicateMessagesSkipped === 1 ? '' : 's') + ' skipped.';
  if (shareResult.creation_queued) msg += ' The optional “request logged” Chat message is queued.';
  if (shareResult.completion_queued) msg += ' Completion notification is enabled.';
  return chatDialogClose_(msg);
}

function chatSubmitExisting(event) {
  try {
    const contextId = chatParams_(event).contextId || '';
    const ctx = ChatTicketing.getContext(contextId, event);
    const draft = chatFormSnapshot_(event, contextId);
    if (!draft.messages.length) return chatDialogError_('Select at least one Chat message.');
    const sharingError = chatValidateSharing_(ctx, draft);
    if (sharingError) return chatDialogError_(sharingError);
    const query = chatFormValue_(event, 'ticket_query').trim();
    if (!query) return chatDialogError_('Enter a ticket number, title, or Project Tracker URL.');
    const rows = Tickets.searchTickets(query, '');
    if (!rows.length) return chatDialogError_('No matching Project Tracker project was found.');
    if (rows.length === 1 || String(rows[0].ticket_id).toLowerCase() === query.toLowerCase()) {
      return chatFinishExisting_(rows[0].ticket_id, draft);
    }
    const draftId = chatSaveExistingDraft_(draft);
    return chatExistingChoiceDialog_(rows, draftId);
  } catch (e) {
    Logger.log('Add Chat to existing failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}

function chatSubmitExistingChoice(event) {
  try {
    const draftId = chatParams_(event).draftId || '';
    const draft = chatGetExistingDraft_(draftId);
    const ticketId = chatFormValue_(event, 'ticket_choice');
    if (!ticketId) return chatDialogError_('Choose a project.');
    return chatFinishExisting_(ticketId, draft);
  } catch (e) {
    Logger.log('Existing Chat project selection failed: %s\n%s', e.message, e.stack);
    return chatDialogError_(e.message);
  }
}
