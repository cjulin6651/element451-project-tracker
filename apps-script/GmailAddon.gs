/** Project Tracker — Google Workspace Add-on UI for Gmail. */

const ADDON_THEME = Object.freeze({
  panel: '#232a30',
  raised: '#2a3239',
  ink: '#f0f2f3',
  slate: '#bcc5cb',
  mist: '#89959e',
  accent: '#7fc4e7',
  accentBg: '#1d3947',
});

const ADDON_FLOW_KEY = 'PROJECT_TRACKER_GMAIL_ACTIVE_FLOW_V1';
const ADDON_FLOW_TTL_MS = 2 * 60 * 60 * 1000;
const ADDON_AUTO_RESUME_MS = 10 * 60 * 1000;

function addonFlowState_() {
  try {
    const raw = PropertiesService.getUserProperties().getProperty(ADDON_FLOW_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    const touched = Number(state && state.touched_at || 0);
    if (!state || !touched || Date.now() - touched > ADDON_FLOW_TTL_MS) {
      PropertiesService.getUserProperties().deleteProperty(ADDON_FLOW_KEY);
      return null;
    }
    return state;
  } catch (e) {
    return null;
  }
}

function addonSetFlowState_(patch) {
  const current = addonFlowState_() || {};
  const next = Object.assign({}, current, patch || {}, { touched_at: Date.now() });
  PropertiesService.getUserProperties().setProperty(ADDON_FLOW_KEY, JSON.stringify(next));
  return next;
}

function addonClearFlowState_() {
  PropertiesService.getUserProperties().deleteProperty(ADDON_FLOW_KEY);
}

function addonThreadIdForMessage_(messageId) {
  const gm = GmailApp.getMessageById(messageId);
  return gm && gm.getThread() ? String(gm.getThread().getId()) : '';
}

function addonBeginFlow_(flow, messageId, extra) {
  const threadId = addonThreadIdForMessage_(messageId);
  return addonSetFlowState_(Object.assign({
    flow: flow,
    thread_id: threadId,
    base_message_id: String(messageId || ''),
    values: {}
  }, extra || {}));
}

function addonHasField_(e, name) {
  e = e || {};
  const modern = e.commonEventObject && e.commonEventObject.formInputs;
  if (modern && Object.prototype.hasOwnProperty.call(modern, name)) return true;
  const legacy = e.formInputs;
  if (legacy && Object.prototype.hasOwnProperty.call(legacy, name)) return true;
  const single = e.formInput;
  return !!(single && Object.prototype.hasOwnProperty.call(single, name));
}

function addonDraftValuesFromEvent_(e) {
  const fields = ['title','details','type','department','size','owner_choice','status','log_mode','selected_message_id','watch_thread','ticket_search'];
  const out = {};
  fields.forEach(function (name) {
    if (addonHasField_(e, name)) out[name] = addonField_(e, name);
  });
  return out;
}

function addonPersistDraft_(e, patch) {
  const state = addonFlowState_();
  if (!state) return null;
  const values = Object.assign({}, state.values || {}, addonDraftValuesFromEvent_(e), patch || {});
  return addonSetFlowState_({ values: values });
}

function gmailDraftChanged(e) {
  try {
    const state = addonPersistDraft_(e) || addonFlowState_();
    if (!state || !state.flow) {
      return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification().setText('Draft saved.'))
        .build();
    }
    const messageId = state.base_message_id || addonParam_(e, 'messageId');
    let card = null;
    if (state.flow === 'create') card = gmailCreateCard_(messageId, state.values || {});
    else if (state.flow === 'existing' && state.ticket_id) card = gmailExistingOptionsCard_(state.ticket_id, messageId, state.values || {});
    if (!card) {
      return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification().setText('Draft saved.'))
        .build();
    }
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(card))
      .build();
  } catch (err) {
    return addonActionError_(err);
  }
}

function addonEmailDisplayName_(header) {
  const value = String(header || '').trim();
  const m = value.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  if (m && m[1]) return m[1].trim();
  const email = value.match(/<?([^<>,\s]+@[^<>,\s]+)>?/);
  return email ? email[1] : value;
}

function addonThreadMessageChoices_(messageId, selectedMessageId) {
  const gm = GmailApp.getMessageById(messageId);
  if (!gm) throw new Error('The Gmail message could not be read.');
  const all = gm.getThread().getMessages();
  const tz = Session.getScriptTimeZone();
  const selected = String(selectedMessageId || messageId || (all.length ? all[all.length - 1].getId() : ''));
  // Card selection widgets have practical size limits. Showing the most recent
  // 100 still covers very long operational threads without overwhelming Gmail.
  const start = Math.max(0, all.length - 100);
  return all.slice(start).map(function (m, offset) {
    const index = start + offset + 1;
    const when = Utilities.formatDate(m.getDate(), tz, 'MMM d, h:mm a');
    const sender = addonEmailDisplayName_(m.getFrom()) || 'Unknown sender';
    return {
      value: String(m.getId()),
      label: index + ' of ' + all.length + ' · ' + when + ' · ' + sender,
      selected: String(m.getId()) === selected
    };
  });
}

function addonHeader_(title, subtitle) {
  const header = CardService.newCardHeader()
    .setTitle(title)
    .setImageUrl(CONFIG.BRAND_LOGO_URL)
    .setImageStyle(CardService.ImageStyle.SQUARE)
    .setImageAltText('Project Tracker');
  if (subtitle) header.setSubtitle(subtitle);
  return header;
}

function addonPrimaryButton_(text, functionName, parameters, icon) {
  const button = CardService.newTextButton()
    .setText(text)
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor(ADDON_THEME.accentBg)
    .setOnClickAction(addonAction_(functionName, parameters));
  if (icon) button.setIcon(icon);
  return button;
}

function addonSecondaryButton_(text, functionName, parameters, icon) {
  const button = CardService.newTextButton()
    .setText(text)
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED_TONAL)
    .setOnClickAction(addonAction_(functionName, parameters));
  if (icon) button.setIcon(icon);
  return button;
}

function addonIcon_(icon) {
  return CardService.newIconImage().setIcon(icon);
}

function gmailRootCard_(messageId) {
  const gm = GmailApp.getMessageById(messageId);
  if (!gm) throw new Error('The Gmail message could not be read.');
  const subject = gm.getSubject() || '(no subject)';
  const section = CardService.newCardSection()
    .setHeader('Current email')
    .addWidget(CardService.newDecoratedText().setTopLabel('Subject').setText(subject).setStartIcon(addonIcon_(CardService.Icon.EMAIL)))
    .addWidget(CardService.newDecoratedText().setTopLabel('From').setText(gm.getFrom() || '').setStartIcon(addonIcon_(CardService.Icon.PERSON)))
    .addWidget(CardService.newButtonSet()
      .addButton(addonPrimaryButton_('Create New Ticket', 'gmailShowCreateTicket', { messageId: messageId }, CardService.Icon.TICKET))
      .addButton(addonSecondaryButton_('Add to Existing', 'gmailShowExistingSearch', { messageId: messageId }, CardService.Icon.DESCRIPTION)));

  return CardService.newCardBuilder()
    .setName('gmail-root')
    .setHeader(addonHeader_('Project Tracker', 'Capture this email into a project'))
    .addSection(section)
    .build();
}

function gmailHomepage(e) {
  const section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(
      '<b>PROJECT TRACKER</b><br>Open an email, then use this panel to create a new ticket or add the conversation to an existing project.'
    ));
  return CardService.newCardBuilder()
    .setHeader(addonHeader_('Project Tracker', 'Gmail capture'))
    .addSection(section)
    .build();
}

function onGmailMessageOpen(e) {
  try {
    const ctx = gmailContext_(e);
    const active = addonFlowState_();

    // Normal entry always shows the simple Create / Existing choice.
    // Only restore an in-progress form when Gmail itself switches to a
    // different message in the same thread shortly after the draft began.
    if (active && active.flow && active.base_message_id &&
        String(active.base_message_id) !== String(ctx.messageId) &&
        Date.now() - Number(active.touched_at || 0) <= ADDON_AUTO_RESUME_MS) {
      const currentThreadId = addonThreadIdForMessage_(ctx.messageId);
      if (currentThreadId && String(active.thread_id || '') === currentThreadId) {
        if (active.flow === 'create') {
          return gmailCreateCard_(active.base_message_id, active.values || {});
        }
        if (active.flow === 'existing' && active.ticket_id) {
          return gmailExistingOptionsCard_(active.ticket_id, active.base_message_id, active.values || {});
        }
      }
    }

    return gmailRootCard_(ctx.messageId);
  } catch (err) {
    return addonErrorCard_(err);
  }
}

function gmailShowCreateTicket(e) {
  try {
    const ctx = gmailContext_(e);
    const messageId = addonParam_(e, 'messageId') || ctx.messageId;
    addonBeginFlow_('create', messageId, { values: {} });
    return addonPush_(gmailCreateCard_(messageId, {}));
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailCreateCard_(messageId, values) {
  values = values || {};
  const gm = GmailApp.getMessageById(messageId);
  const subject = gm.getSubject() || '(no subject)';
  const user = Repo.requireAccess('agent');
  const agents = Repo.activeAgents().filter(function (a) { return a.role === 'agent'; });
  const types = Repo.activeTypes();
  const departments = Repo.activeDepartments();
  const sizes = Repo.sizes();
  const selectedType = values.type || (types[0] ? types[0].type_name : '');
  const typeRow = types.filter(function (t) { return t.type_name === selectedType; })[0];
  const selectedSize = values.size || (typeRow ? (typeRow.default_size || 'M') : 'M');
  const userEmail = String(user.email || '').toLowerCase();
  const userIsAssignable = agents.some(function (a) { return String(a.email || '').toLowerCase() === userEmail; });
  const ownerChoice = values.owner_choice || (userIsAssignable ? userEmail : (agents[0] ? String(agents[0].email || '').toLowerCase() : ''));
  const status = values.status || STATUS.IN_PROGRESS;

  const typeInput = addonDropdown_('type', 'Type', types.map(function (t) { return [t.type_name, t.type_name]; }), selectedType)
    .setOnChangeAction(addonAction_('gmailCreateTypeChanged', { messageId: messageId }));

  const fields = CardService.newCardSection().setHeader('Ticket details')
    .addWidget(CardService.newTextInput().setFieldName('title').setTitle('Title').setValue(values.title !== undefined ? values.title : subject))
    .addWidget(CardService.newTextInput().setFieldName('details').setTitle('Project details').setHint('Optional — left blank by default').setMultiline(true).setValue(values.details || ''))
    .addWidget(typeInput)
    .addWidget(addonDropdown_('department', 'Department', [['__none__', '— None —']].concat(departments.map(function (d) { return [d.dept_name, d.dept_name]; })), values.department || '__none__'))
    .addWidget(addonDropdown_('size', 'Size', sizes.map(function (x) { return [x.code, x.code + ' · ' + x.time_guidance]; }), selectedSize))
    .addWidget(addonOwnerChoice_(agents, ownerChoice, user.email))
    .addWidget(addonDropdown_('status', 'Status', [['in_progress', 'In progress'], ['up_next', 'Up next'], ['wish_list', 'Wish list']], status));

  const save = CardService.newCardSection().addWidget(
    addonPrimaryButton_('Create Ticket from Email', 'gmailCreateTicketFromEmail', { messageId: messageId }, CardService.Icon.TICKET)
  );

  return CardService.newCardBuilder()
    .setName('gmail-create')
    .setHeader(addonHeader_('Create New Ticket', subject))
    .addSection(fields)
    .addSection(addonEmailOptionsSection_(messageId, values.log_mode || 'full', values.selected_message_id || messageId, values.watch_thread === 'yes'))
    .addSection(save)
    .addSection(CardService.newCardSection().addWidget(addonSecondaryButton_('Back to Start', 'gmailReturnHome', { messageId: messageId })))
    .build();
}

function gmailCreateTypeChanged(e) {
  try {
    gmailContext_(e);
    const messageId = addonParam_(e, 'messageId');
    const state = addonFlowState_() || {};
    const values = Object.assign({}, state.values || {}, addonDraftValuesFromEvent_(e));
    const type = addonField_(e, 'type');
    const typeRow = Repo.activeTypes().filter(function (t) { return t.type_name === type; })[0];
    values.type = type;
    values.size = typeRow ? (typeRow.default_size || 'M') : 'M';
    if (!values.status) values.status = STATUS.IN_PROGRESS;
    if (!values.log_mode) values.log_mode = 'full';
    if (!values.selected_message_id) values.selected_message_id = messageId;
    addonSetFlowState_({ values: values });
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(gmailCreateCard_(messageId, values)))
      .build();
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailLogModeChanged(e) {
  try {
    gmailContext_(e);
    const state = addonFlowState_() || {};
    const messageId = state.base_message_id || addonParam_(e, 'messageId');
    const values = Object.assign({}, state.values || {}, addonDraftValuesFromEvent_(e));
    values.log_mode = addonField_(e, 'log_mode') || values.log_mode || (state.flow === 'existing' ? 'latest' : 'full');
    if (!values.selected_message_id) values.selected_message_id = messageId;
    addonSetFlowState_({ values: values });

    let card;
    if (state.flow === 'existing' && state.ticket_id) {
      card = gmailExistingOptionsCard_(state.ticket_id, messageId, values);
    } else {
      card = gmailCreateCard_(messageId, values);
    }
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(card))
      .build();
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailReturnHome(e) {
  try {
    const ctx = gmailContext_(e);
    const messageId = addonParam_(e, 'messageId') || ctx.messageId;
    addonClearFlowState_();
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(gmailRootCard_(messageId)))
      .build();
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailPendingCreateTicket_(payload) {
  // Gmail action callbacks can be retried after a host timeout. Persist the
  // newly-created ticket in the active flow before the slower email import so
  // a retry resumes the same ticket instead of creating a duplicate project.
  const userLock = LockService.getUserLock();
  if (!userLock.tryLock(5000)) {
    throw new Error('Project Tracker is already creating this ticket. Please wait a moment and try again.');
  }
  try {
    const state = addonFlowState_() || {};
    const pendingId = String(state.pending_ticket_id || '').trim();
    if (pendingId) {
      const finder = Repo.findOneFast || Repo.findOne;
      const existing = finder(TABS.TICKETS, 'ticket_id', pendingId);
      if (existing && existing.deleted !== true && existing.deleted !== 'TRUE') {
        return { ticket: existing, reused: true };
      }
      addonSetFlowState_({ pending_ticket_id: '' });
    }

    const ticket = Tickets.create(Object.assign({}, payload || {}, { _creationSource: 'gmail' }));
    addonSetFlowState_({ pending_ticket_id: ticket.ticket_id });
    return { ticket: ticket, reused: false };
  } finally {
    userLock.releaseLock();
  }
}

function gmailCreateTicketFromEmail(e) {
  try {
    gmailContext_(e);
    const title = addonField_(e, 'title').trim();
    if (!title) throw new Error('Ticket title is required.');
    const ownerChoice = addonField_(e, 'owner_choice');
    const legacyOwners = addonFields_(e, 'owners');
    const owners = ownerChoice ? ownerChoice.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : legacyOwners;
    const payload = {
      title: title,
      description: addonField_(e, 'details'),
      description_markup: addonField_(e, 'details'),
      type: addonField_(e, 'type'),
      department: addonField_(e, 'department') === '__none__' ? '' : addonField_(e, 'department'),
      size: addonField_(e, 'size') || 'M',
      owners: owners.length ? owners : (Repo.activeAgents().filter(function (a) { return String(a.role || '').toLowerCase() === 'agent'; }).slice(0, 1).map(function (a) { return a.email; })),
      status: addonField_(e, 'status') || STATUS.IN_PROGRESS
    };
    const mode = addonField_(e, 'log_mode') || 'full';
    const watch = addonField_(e, 'watch_thread') === 'yes';
    const baseMessageId = addonParam_(e, 'messageId');
    const selectedMessageId = addonField_(e, 'selected_message_id') || baseMessageId;
    const messageId = mode === 'current' ? selectedMessageId : baseMessageId;

    const pending = gmailPendingCreateTicket_(payload);
    const out = GmailTicketing.addToExisting(pending.ticket.ticket_id, messageId, mode, watch, {
      dedupeThread: pending.reused,
      skipAccessValidation: true
    });
    addonClearFlowState_();
    return addonSuccess_(out.ticket, out.projectUrl, watch, pending.reused ? 'Ticket recovered and email logged.' : 'Ticket created and email logged.', messageId);
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailShowExistingSearch(e) {
  try {
    const ctx = gmailContext_(e);
    addonBeginFlow_('search', ctx.messageId);
    const section = CardService.newCardSection()
      .setHeader('Find a ticket')
      .addWidget(CardService.newTextInput()
        .setFieldName('ticket_search')
        .setTitle('Project URL, ticket number, or name')
        .setHint('Example: TKT-0042, a project title, or a shared Project Tracker URL'))
      .addWidget(addonPrimaryButton_('Search', 'gmailSearchExistingTickets', { messageId: ctx.messageId }, CardService.Icon.DESCRIPTION));
    return addonPush_(CardService.newCardBuilder()
      .setName('gmail-search')
      .setHeader(addonHeader_('Add to Existing Ticket', 'Search Project Tracker'))
      .addSection(section)
      .build());
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailSearchExistingTickets(e) {
  try {
    gmailContext_(e);
    const q = addonField_(e, 'ticket_search').trim();
    if (!q) throw new Error('Enter a project URL, ticket number, or ticket name.');
    const rows = GmailTicketing.searchTickets(q);
    const section = CardService.newCardSection().setHeader(rows.length ? 'Matches' : 'No matches');
    if (!rows.length) {
      section.addWidget(CardService.newTextParagraph().setText('No ticket matched <b>' + addonEsc_(q) + '</b>.'));
    } else {
      rows.forEach(function (r) {
        section.addWidget(CardService.newDecoratedText()
          .setText(r.title || r.ticket_id)
          .setBottomLabel(r.ticket_id + ' · ' + addonStatusLabel_(r))
          .setButton(addonSecondaryButton_('Select', 'gmailChooseExistingTicket', {
            messageId: addonParam_(e, 'messageId'),
            ticketId: r.ticket_id
          }, CardService.Icon.TICKET)));
      });
    }
    return addonPush_(CardService.newCardBuilder()
      .setName('gmail-results')
      .setHeader(addonHeader_('Search Results', q))
      .addSection(section)
      .build());
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailExistingOptionsCard_(ticketId, messageId, values) {
  values = values || {};
  const ticket = Tickets.get(ticketId).ticket;
  const section = CardService.newCardSection().setHeader('Selected ticket')
    .addWidget(CardService.newDecoratedText().setText(ticket.title).setBottomLabel(ticket.ticket_id + ' · ' + addonStatusLabel_(ticket)).setStartIcon(addonIcon_(CardService.Icon.TICKET)));
  const save = CardService.newCardSection().addWidget(addonPrimaryButton_('Add Email to Ticket', 'gmailAddEmailToExisting', {
    messageId: messageId,
    ticketId: ticketId
  }, CardService.Icon.EMAIL));
  return CardService.newCardBuilder()
    .setName('gmail-existing-options')
    .setHeader(addonHeader_('Add Email', ticket.title))
    .addSection(section)
    .addSection(addonEmailOptionsSection_(messageId, values.log_mode || 'latest', values.selected_message_id || messageId, values.watch_thread === 'yes'))
    .addSection(save)
    .addSection(CardService.newCardSection().addWidget(addonSecondaryButton_('Back to Start', 'gmailReturnHome', { messageId: messageId })))
    .build();
}

function gmailChooseExistingTicket(e) {
  try {
    gmailContext_(e);
    const ticketId = addonParam_(e, 'ticketId');
    const messageId = addonParam_(e, 'messageId');
    const values = { log_mode: 'latest', selected_message_id: messageId, watch_thread: '' };
    addonSetFlowState_({ flow: 'existing', ticket_id: ticketId, base_message_id: messageId, values: values });
    return addonPush_(gmailExistingOptionsCard_(ticketId, messageId, values));
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailAddEmailToExisting(e) {
  try {
    gmailContext_(e);
    const ticketId = addonParam_(e, 'ticketId');
    const mode = addonField_(e, 'log_mode') || 'latest';
    const watch = addonField_(e, 'watch_thread') === 'yes';
    const baseMessageId = addonParam_(e, 'messageId');
    const selectedMessageId = addonField_(e, 'selected_message_id') || baseMessageId;
    const messageId = mode === 'current' ? selectedMessageId : baseMessageId;
    const out = GmailTicketing.addToExisting(ticketId, messageId, mode, watch);
    addonClearFlowState_();
    return addonSuccess_(out.ticket, out.projectUrl, watch, 'Email added to ticket.', messageId);
  } catch (err) {
    return addonActionError_(err);
  }
}

function gmailContext_(e) {
  e = e || {};
  const gmail = e.gmail || {};
  const meta = e.messageMetadata || {};
  const accessToken = gmail.accessToken || meta.accessToken || '';
  const messageId = gmail.messageId || meta.messageId || addonParam_(e, 'messageId');
  if (!messageId) throw new Error('Open a Gmail message before using Project Tracker.');
  if (accessToken) GmailApp.setCurrentMessageAccessToken(accessToken);
  return { messageId: messageId, threadId: gmail.threadId || '' };
}

function addonEmailOptionsSection_(messageId, selectedMode, selectedMessageId, watchSelected) {
  const modeAction = addonAction_('gmailLogModeChanged', { messageId: messageId });
  const mode = CardService.newSelectionInput()
    .setFieldName('log_mode')
    .setTitle('Email content to log')
    .setType(CardService.SelectionInputType.RADIO_BUTTON)
    .addItem('One email from this thread', 'current', selectedMode === 'current')
    .addItem('Most recent email', 'latest', selectedMode === 'latest')
    .addItem('Full thread', 'full', selectedMode === 'full')
    .setOnChangeAction(modeAction);

  const section = CardService.newCardSection().setHeader('Email logging')
    .addWidget(CardService.newTextParagraph().setText('Choose what to log without leaving this ticket draft.'))
    .addWidget(mode);

  // Fetch the thread message list only when the user actually asks to choose
  // one specific message. This keeps the normal Create/Existing forms fast.
  if (selectedMode === 'current') {
    const choices = addonThreadMessageChoices_(messageId, selectedMessageId);
    const messagePicker = CardService.newSelectionInput()
      .setFieldName('selected_message_id')
      .setTitle('Email to log')
      .setType(CardService.SelectionInputType.DROPDOWN);
    choices.forEach(function (x) { messagePicker.addItem(x.label, x.value, x.selected); });
    section.addWidget(messagePicker);
  }

  const watch = CardService.newDecoratedText()
    .setText('Automatically log future replies')
    .setBottomLabel('New messages on this Gmail thread will be added as new ticket notes.')
    .setStartIcon(addonIcon_(CardService.Icon.CLOCK))
    .setSwitchControl(CardService.newSwitch()
      .setFieldName('watch_thread')
      .setValue('yes')
      .setSelected(!!watchSelected));
  section.addWidget(watch);
  return section;
}

function addonOwnerChoice_(agents, selectedValue, currentEmail, changeAction) {
  const input = CardService.newSelectionInput()
    .setFieldName('owner_choice')
    .setTitle('Owner')
    .setType(CardService.SelectionInputType.RADIO_BUTTON);
  const normalized = String(selectedValue || '').toLowerCase();
  const rows = agents.slice();
  rows.forEach(function (a) {
    const email = String(a.email || '').toLowerCase();
    const label = String(a.display_name || a.email || '').split(/\s+/)[0] || a.email;
    input.addItem(label, email, normalized === email || (!normalized && email === String(currentEmail || '').toLowerCase()));
  });
  if (rows.length > 1) {
    const allValue = rows.map(function (a) { return String(a.email || '').toLowerCase(); }).join(',');
    input.addItem(rows.length === 2 ? 'Both' : 'All', allValue, normalized === allValue.toLowerCase());
  }
  if (changeAction) input.setOnChangeAction(changeAction);
  return input;
}

function addonDropdown_(field, title, items, selected, changeAction) {
  const input = CardService.newSelectionInput().setFieldName(field).setTitle(title).setType(CardService.SelectionInputType.DROPDOWN);
  items.forEach(function (x) { input.addItem(x[1], x[0], String(x[0]) === String(selected)); });
  if (changeAction) input.setOnChangeAction(changeAction);
  return input;
}

function addonAction_(functionName, parameters) {
  const a = CardService.newAction().setFunctionName(functionName);
  if (parameters) {
    const clean = {};
    Object.keys(parameters).forEach(function (k) { clean[k] = String(parameters[k] == null ? '' : parameters[k]); });
    a.setParameters(clean);
  }
  return a;
}

function addonParam_(e, name) {
  e = e || {};
  const c = e.commonEventObject || {};
  return String((c.parameters && c.parameters[name]) || (e.parameters && e.parameters[name]) || '');
}

function addonFields_(e, name) {
  e = e || {};
  const inputs = e.commonEventObject && e.commonEventObject.formInputs;
  const item = inputs && inputs[name];
  if (item && item.stringInputs && Array.isArray(item.stringInputs.value)) return item.stringInputs.value.map(String);
  const old = e.formInputs && e.formInputs[name];
  if (old && old.length) return old.map(String);
  const single = e.formInput && e.formInput[name];
  return single === undefined || single === null || single === '' ? [] : [String(single)];
}

function addonField_(e, name) {
  const vals = addonFields_(e, name);
  return vals.length ? vals[0] : '';
}

function addonPush_(card) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card))
    .build();
}

function addonSuccess_(ticket, projectUrl, watch, message, messageId) {
  const section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText('<b>' + addonEsc_(ticket.ticket_id + ' · ' + ticket.title) + '</b><br>' + addonEsc_(message)))
    .addWidget(CardService.newDecoratedText()
      .setText(watch ? 'Watching this Gmail thread' : 'This thread is not being watched')
      .setBottomLabel(watch ? 'Future replies will be checked hourly and logged automatically.' : 'Only the email you selected was logged.'));
  if (projectUrl) {
    section.addWidget(CardService.newTextButton()
      .setText('Open Project Tracker')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor(ADDON_THEME.accentBg)
      .setIcon(CardService.Icon.TICKET)
      .setOpenLink(CardService.newOpenLink().setUrl(projectUrl)));
  }
  if (messageId) {
    section.addWidget(CardService.newButtonSet()
      .addButton(addonPrimaryButton_('Create Another Ticket', 'gmailShowCreateTicket', { messageId: messageId }, CardService.Icon.TICKET))
      .addButton(addonSecondaryButton_('Add to Existing', 'gmailShowExistingSearch', { messageId: messageId }, CardService.Icon.DESCRIPTION)));
  }
  const card = CardService.newCardBuilder()
    .setName('gmail-success')
    .setHeader(addonHeader_('Saved to Project Tracker', ticket.ticket_id))
    .addSection(section)
    .build();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card))
    .setNotification(CardService.newNotification().setText(message))
    .setStateChanged(true)
    .build();
}

function addonActionError_(err) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(String(err && err.message || err)))
    .build();
}

function addonErrorCard_(err) {
  return CardService.newCardBuilder()
    .setHeader(addonHeader_('Project Tracker', 'Something went wrong'))
    .addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(addonEsc_(String(err && err.message || err)))))
    .build();
}

function addonStatusLabel_(t) {
  if (t.substatus === SUBSTATUS.ON_HOLD) return 'On hold';
  if (t.status === STATUS.WISH) return 'Wish list';
  if (t.status === STATUS.UP_NEXT) return 'Up next';
  if (t.status === STATUS.IN_PROGRESS) return 'In progress';
  if (t.status === STATUS.COMPLETED) return t.substatus === SUBSTATUS.HALTED ? 'Halted' : 'Completed';
  return t.status || '';
}

function addonEsc_(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
