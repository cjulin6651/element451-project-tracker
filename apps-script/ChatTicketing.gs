/**
 * Project Tracker — Google Chat backend
 *
 * Reads user-authorized Chat context, imports selected messages as immutable
 * timestamp-accurate CHAT activities, reuses Gmail's student/resource enrichment,
 * stores origin-space completion settings, creates per-user completion triggers,
 * and sends optional Chat notifications without Workspace domain-wide delegation.
 */

const ChatTicketing = (function () {
  const CTX_PREFIX = 'pt_chat_ctx_';
  const SA_CACHE_KEY = 'pt_chat_service_account_token';
  const ORIGIN_TRIGGER_HANDLER = 'processProjectTrackerHourlyJobs';
  const LEGACY_ORIGIN_TRIGGER_HANDLER = 'processProjectTrackerChatCompletions';
  const RECENT_SOURCES_KEY = 'pt_chat_recent_sources_v2';
  const PENDING_SHARING_KEY = 'pt_chat_pending_sharing_v1';
  const PENDING_CREATE_EFFECTS_KEY = 'pt_chat_pending_create_effects_v1';
  // CacheService is fast but intentionally best-effort. Chat dialogs can span
  // multiple add-on executions, so keep a chunked per-user fallback copy too.
  const CTX_PROP_PREFIX = 'pt_chat_ctx_store_';
  const CTX_LATEST_PREFIX = 'pt_chat_ctx_latest_';
  const CTX_LATEST_USER_PREFIX = 'pt_chat_ctx_latest_user_';
  const CTX_PROP_CHUNK_SIZE = 7000;
  const CTX_DURABLE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const CTX_CLEANUP_CACHE_KEY = 'pt_chat_ctx_cleanup_v1';

  function bool_(v) {
    return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1' || v === 'on';
  }

  function requireWriter_() {
    return Repo.requireAccess('agent');
  }

  function spaceNameFromEvent_(event) {
    event = event || {};
    const chat = event.chat || {};
    const p = chat.appCommandPayload || chat.buttonClickedPayload || chat.messagePayload || {};
    const space = p.space || (p.message && p.message.space) || chat.space || event.space || {};
    return String(space.name || '');
  }

  function spaceFromEvent_(event) {
    event = event || {};
    const chat = event.chat || {};
    const p = chat.appCommandPayload || chat.buttonClickedPayload || chat.messagePayload || {};
    return p.space || (p.message && p.message.space) || chat.space || event.space || {};
  }

  function anchorMessageFromEvent_(event) {
    event = event || {};
    const chat = event.chat || {};
    const p = chat.appCommandPayload || chat.buttonClickedPayload || chat.messagePayload || {};
    return p.message || event.message || null;
  }

  function invokingUserFromEvent_(event) {
    event = event || {};
    const chat = event.chat || {};
    const p = chat.appCommandPayload || chat.buttonClickedPayload || chat.messagePayload || {};
    return p.user || event.user || chat.user || {};
  }

  function userId_(name) {
    const m = String(name || '').match(/^users\/(.+)$/);
    return m ? m[1] : '';
  }

  function peopleFetch_(path, token) {
    const response = UrlFetchApp.fetch('https://people.googleapis.com/v1/' + String(path || '').replace(/^\//, ''), {
      method: 'get',
      headers: { Authorization: 'Bearer ' + String(token || ScriptApp.getOAuthToken()) },
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const text = response.getContentText();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch (ignore) {}
    if (code < 200 || code >= 300) {
      const msg = parsed && parsed.error && parsed.error.message ? parsed.error.message : ('HTTP ' + code);
      throw new Error(msg);
    }
    return parsed;
  }

  function personFromChatUser_(user) {
    user = user || {};
    const out = {
      user_name: String(user.name || ''),
      email: String(user.email || '').toLowerCase(),
      display_name: String(user.displayName || ''),
      type: String(user.type || '')
    };
    if (out.type === 'BOT' || out.type === 'APP') return out;
    if (out.email && out.display_name) return out;

    const id = userId_(out.user_name);
    if (!id) return out;
    const cache = CacheService.getUserCache();
    const cacheKey = 'pt_chat_person_' + id.replace(/[^A-Za-z0-9_-]/g, '_').substring(0, 120);
    try {
      const cached = cache.get(cacheKey);
      if (cached) {
        const person = JSON.parse(cached);
        if (!out.display_name) out.display_name = String(person.display_name || '');
        if (!out.email) out.email = String(person.email || '').toLowerCase();
        return out;
      }
    } catch (ignore) {}
    try {
      const p = peopleFetch_('people/' + encodeURIComponent(id) + '?personFields=names%2CemailAddresses');
      if (!out.display_name && p.names && p.names.length) out.display_name = String(p.names[0].displayName || '');
      if (!out.email && p.emailAddresses && p.emailAddresses.length) {
        const primary = p.emailAddresses.filter(function (x) { return x.metadata && x.metadata.primary; })[0] || p.emailAddresses[0];
        out.email = String(primary.value || '').toLowerCase();
      }
      cache.put(cacheKey, JSON.stringify({ display_name: out.display_name, email: out.email }), Number(CONFIG.CHAT_CONTEXT_CACHE_SECONDS) || 1200);
    } catch (ignore) {}
    return out;
  }


  function listParticipants_(spaceName, event) {
    const byName = {};
    const unresolved = [];
    const cache = CacheService.getUserCache();

    // Keep the Chat membership read cheap. Group conversations can contain many
    // people, and resolving each member through People API one-by-one can exceed
    // Google Chat's short interactive callback window. Collect members first,
    // use cached identities where available, then resolve the remainder in one
    // People API batch request.
    try {
      let token = '';
      do {
        const opts = { pageSize: 100 };
        if (token) opts.pageToken = token;
        const out = Chat.Spaces.Members.list(spaceName, opts);
        (out.memberships || []).forEach(function (m) {
          const u = m.member || {};
          const person = {
            user_name: String(u.name || ''),
            email: String(u.email || '').toLowerCase(),
            display_name: String(u.displayName || ''),
            type: String(u.type || '')
          };
          if (!person.user_name || person.type === 'BOT' || person.type === 'APP') return;

          const id = userId_(person.user_name);
          if ((!person.email || !person.display_name) && id) {
            const cacheKey = 'pt_chat_person_' + id.replace(/[^A-Za-z0-9_-]/g, '_').substring(0, 120);
            try {
              const cached = cache.get(cacheKey);
              if (cached) {
                const saved = JSON.parse(cached);
                if (!person.display_name) person.display_name = String(saved.display_name || '');
                if (!person.email) person.email = String(saved.email || '').toLowerCase();
              }
            } catch (ignore) {}
            if (!person.email || !person.display_name) unresolved.push({ id: id, cache_key: cacheKey, person: person });
          }
          byName[person.user_name] = person;
        });
        token = String(out.nextPageToken || '');
      } while (token);
    } catch (e) {
      Logger.log('Chat membership lookup failed: %s', e.message);
    }

    if (unresolved.length) {
      try {
        const seen = {};
        const resourceNames = [];
        unresolved.forEach(function (x) {
          const name = 'people/' + x.id;
          if (!seen[name]) { seen[name] = true; resourceNames.push(name); }
        });
        const token = ScriptApp.getOAuthToken();
        // People batchGet supports multiple resourceNames in one request. Keep
        // batches modest so large spaces remain predictable.
        for (let start = 0; start < resourceNames.length; start += 50) {
          const chunk = resourceNames.slice(start, start + 50);
          const query = chunk.map(function (name) { return 'resourceNames=' + encodeURIComponent(name); }).join('&') +
            '&personFields=' + encodeURIComponent('names,emailAddresses');
          const batch = peopleFetch_('people:batchGet?' + query, token);
          const found = {};
          (batch.responses || []).forEach(function (r) {
            const p = r && r.person || {};
            const requested = String(r && r.requestedResourceName || p.resourceName || '');
            if (!requested) return;
            found[requested] = directoryPerson_(p);
          });
          unresolved.forEach(function (x) {
            const resolved = found['people/' + x.id];
            if (!resolved) return;
            if (!x.person.display_name) x.person.display_name = String(resolved.display_name || '');
            if (!x.person.email) x.person.email = String(resolved.email || '').toLowerCase();
            try {
              cache.put(x.cache_key, JSON.stringify({ display_name: x.person.display_name, email: x.person.email }), Number(CONFIG.CHAT_CONTEXT_CACHE_SECONDS) || 1200);
            } catch (ignore) {}
          });
        }
      } catch (e) {
        Logger.log('Chat participant People batch lookup failed: %s', e.message);
      }
    }

    // The invoking user's event payload is usually already populated; resolve it
    // only if necessary, preserving the existing one-to-one behavior.
    const inv = personFromChatUser_(invokingUserFromEvent_(event));
    if (inv.user_name) byName[inv.user_name] = Object.assign({}, byName[inv.user_name] || {}, inv);
    return Object.keys(byName).map(function (k) { return byName[k]; });
  }

  function dedupeAttachments_(attachments) {
    const out = [], seen = {};
    (attachments || []).forEach(function (a) {
      a = a || {};
      const driveId = String(a.drive_file_id || a.driveFileId || '').trim();
      const mediaName = String(a.attachment_resource_name || (a.attachmentDataRef && a.attachmentDataRef.resourceName) || '').trim();
      const contentName = String(a.content_name || a.contentName || '').trim();
      const contentType = String(a.content_type || a.contentType || '').trim().toLowerCase();
      const source = String(a.source || '').trim().toLowerCase();
      let key = '';
      if (driveId) key = 'drive:' + driveId;
      else if (mediaName) key = 'media:' + mediaName;
      else key = 'file:' + contentName.toLowerCase() + '|' + contentType + '|' + source;
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(a);
    });
    return out;
  }

  function normalizeMessage_(message) {
    message = message || {};
    const rawSender = message.sender || {};
    // Do not resolve every message sender through People API here. A cold Chat
    // can contain messages from several people, and doing those lookups one at
    // a time is expensive. buildContextForSpace() already resolves the space
    // membership in one batch; message senders are enriched from that result.
    const sender = {
      user_name: String(rawSender.name || ''),
      email: String(rawSender.email || '').toLowerCase(),
      display_name: String(rawSender.displayName || ''),
      type: String(rawSender.type || '')
    };
    const attachments = dedupeAttachments_((message.attachment || message.attachments || []).map(function (a) {
      return {
        name: String(a.name || ''),
        content_name: String(a.contentName || 'Attachment'),
        content_type: String(a.contentType || 'application/octet-stream'),
        source: String(a.source || ''),
        attachment_resource_name: String(a.attachmentDataRef && a.attachmentDataRef.resourceName || ''),
        drive_file_id: String(a.driveDataRef && a.driveDataRef.driveFileId || '')
      };
    }));
    return {
      name: String(message.name || ''),
      create_time: String(message.createTime || message.lastUpdateTime || Repo.now()),
      text: String(message.text || ''),
      formatted_text: String(message.formattedText || ''),
      sender: sender,
      thread_name: String(message.thread && message.thread.name || ''),
      attachments: attachments
    };
  }

  function enrichMessageSenders_(messages, participants) {
    const byName = {};
    const byEmail = {};
    (participants || []).forEach(function (p) {
      if (p && p.user_name) byName[String(p.user_name)] = p;
      if (p && p.email) byEmail[String(p.email).toLowerCase()] = p;
    });
    const fallbackByName = {};
    return (messages || []).map(function (m) {
      const sender = m && m.sender || {};
      let resolved = sender.user_name ? byName[String(sender.user_name)] : null;
      if (!resolved && sender.email) resolved = byEmail[String(sender.email).toLowerCase()] || null;
      // A sender who has since left the space might not be in memberships. Keep
      // the old behavior for that rare case, but resolve each missing user only
      // once instead of once per message.
      if (!resolved && sender.user_name) {
        const key = String(sender.user_name);
        if (fallbackByName[key] === undefined) fallbackByName[key] = personFromChatUser_({
          name: sender.user_name,
          email: sender.email,
          displayName: sender.display_name,
          type: sender.type
        });
        resolved = fallbackByName[key];
      }
      if (resolved) m.sender = {
        user_name: String(resolved.user_name || sender.user_name || ''),
        email: String(resolved.email || sender.email || '').toLowerCase(),
        display_name: String(resolved.display_name || sender.display_name || ''),
        type: String(resolved.type || sender.type || '')
      };
      return m;
    });
  }

  function listRecentMessages_(spaceName, anchorMessage) {
    const limit = Math.max(5, Math.min(50, Number(CONFIG.CHAT_CONTEXT_MESSAGE_LIMIT) || 30));
    let rows = [];
    try {
      const out = Chat.Spaces.Messages.list(spaceName, { pageSize: Math.max(limit, 30), orderBy: 'createTime DESC' });
      rows = out.messages || [];
    } catch (e) {
      const out = Chat.Spaces.Messages.list(spaceName, { pageSize: Math.max(limit, 30) });
      rows = out.messages || [];
    }
    rows = rows.map(normalizeMessage_).sort(function (a, b) {
      return String(b.create_time).localeCompare(String(a.create_time));
    });

    const anchor = anchorMessage ? normalizeMessage_(anchorMessage) : null;
    if (anchor && anchor.name && !rows.some(function (m) { return m.name === anchor.name; })) rows.unshift(anchor);
    return rows.slice(0, limit);
  }

  function conversationLabel_(space, participants, meEmail, meUserName) {
    space = space || {};
    participants = participants || [];
    const others = participants.filter(function (p) {
      const email = String(p.email || '').toLowerCase();
      const name = String(p.user_name || '');
      if (meEmail && email && email === meEmail) return false;
      if (meUserName && name && name === meUserName) return false;
      return true;
    });
    const names = others.map(function (p) { return String(p.display_name || p.email || '').trim(); }).filter(Boolean);
    const type = String(space.spaceType || space.type || '');
    if (type === 'DIRECT_MESSAGE') return names[0] || String(space.displayName || 'Direct message');
    if (type === 'GROUP_CHAT') {
      if (String(space.displayName || '').trim()) return String(space.displayName).trim();
      if (names.length <= 3) return names.join(', ') || 'Group chat';
      return names.slice(0, 3).join(', ') + ' +' + (names.length - 3);
    }
    return String(space.displayName || '').trim() || names.join(', ') || String(space.name || 'Chat conversation');
  }

  function recentSources() {
    const limit = Math.max(1, Math.min(8, Number(CONFIG.CHAT_RECENT_SOURCE_LIMIT) || 5));
    try {
      const raw = PropertiesService.getUserProperties().getProperty(RECENT_SOURCES_KEY);
      const rows = raw ? JSON.parse(raw) : [];
      return (Array.isArray(rows) ? rows : []).filter(function (r) { return r && r.space_name; }).slice(0, limit);
    } catch (e) {
      return [];
    }
  }

  function saveRecentSources_(rows) {
    const limit = Math.max(1, Math.min(8, Number(CONFIG.CHAT_RECENT_SOURCE_LIMIT) || 5));
    const seen = {};
    const clean = (rows || []).filter(function (r) {
      const key = String(r && r.space_name || '');
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    }).slice(0, limit);
    try { PropertiesService.getUserProperties().setProperty(RECENT_SOURCES_KEY, JSON.stringify(clean)); } catch (ignore) {}
    return clean;
  }

  /**
   * Pull the user's genuinely recent human-to-human DMs from Google Chat.
   *
   * The original picker only knew chats that Project Tracker had previously
   * opened, which meant a first-time user had to type a coworker's email before
   * the conversation could ever appear under Recent chats. This does one spaces
   * lookup, resolves the handful of newest DMs in parallel, then batches the
   * People lookup so the callback stays comfortably below Chat's UI timeout.
   */
  function discoverRecentDirectSources(event) {
    requireWriter_();
    const currentSpace = spaceNameFromEvent_(event);
    const invoker = invokingUserFromEvent_(event) || {};
    const meUserName = String(invoker.name || '');
    const meEmail = String(Repo.me() || '').toLowerCase();
    const maxRows = Math.max(4, Math.min(8, Number(CONFIG.CHAT_RECENT_SOURCE_LIMIT) || 5));
    let spaces = [];

    try {
      const out = Chat.Spaces.list({ pageSize: 1000, filter: 'spaceType = "DIRECT_MESSAGE"' });
      spaces = (out.spaces || []).filter(function (space) {
        if (!space || !space.name || String(space.name) === String(currentSpace)) return false;
        if (space.singleUserBotDm === true) return false;
        const count = Number(space.membershipCount && space.membershipCount.joinedDirectHumanUserCount || 0);
        // Human-to-human DMs contain two direct human members. If the API omits
        // membershipCount, keep the candidate and verify it from memberships.
        if (count && count !== 2) return false;
        return true;
      });
    } catch (e) {
      Logger.log('Recent direct Chat discovery failed while listing spaces: %s', e.message);
      return recentSources();
    }

    spaces.sort(function (a, b) {
      return String(b.lastActiveTime || '').localeCompare(String(a.lastActiveTime || ''));
    });
    // Resolve a few extra candidates in case one turns out to be an app DM or
    // an inaccessible/stale conversation.
    spaces = spaces.slice(0, Math.min(12, Math.max(maxRows + 3, 7)));
    if (!spaces.length) return recentSources();

    const token = ScriptApp.getOAuthToken();
    const requests = spaces.map(function (space) {
      return {
        url: 'https://chat.googleapis.com/v1/' + String(space.name).replace(/^\//, '') + '/members?pageSize=10&filter=' + encodeURIComponent('member.type = "HUMAN"'),
        method: 'get',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      };
    });

    let membershipResponses = [];
    try { membershipResponses = UrlFetchApp.fetchAll(requests); }
    catch (e) {
      Logger.log('Recent direct Chat discovery failed while listing memberships: %s', e.message);
      return recentSources();
    }

    const peers = [];
    const peerNames = {};
    membershipResponses.forEach(function (response, i) {
      if (!response || response.getResponseCode() < 200 || response.getResponseCode() >= 300) return;
      let parsed = {};
      try { parsed = JSON.parse(response.getContentText() || '{}'); } catch (ignore) { return; }
      const members = (parsed.memberships || []).map(function (m) { return m && m.member || {}; }).filter(function (u) {
        return String(u.type || '') !== 'BOT' && !!String(u.name || '');
      });
      if (members.length < 2) return;
      let peer = members.filter(function (u) { return !meUserName || String(u.name || '') !== meUserName; })[0] || null;
      if (!peer || !peer.name) return;
      const chatName = String(peer.name || '');
      const id = userId_(chatName);
      if (!id) return;
      const personResource = 'people/' + id;
      peerNames[spaces[i].name] = personResource;
      if (peers.indexOf(personResource) < 0) peers.push(personResource);
    });

    const peopleByResource = {};
    if (peers.length) {
      try {
        const query = peers.map(function (name) { return 'resourceNames=' + encodeURIComponent(name); }).join('&') +
          '&personFields=' + encodeURIComponent('names,emailAddresses');
        const batch = peopleFetch_('people:batchGet?' + query, token);
        (batch.responses || []).forEach(function (r) {
          const person = r && r.person || {};
          const requested = String(r && r.requestedResourceName || person.resourceName || '');
          const normalized = directoryPerson_(person);
          if (requested) peopleByResource[requested] = normalized;
          if (person.resourceName) peopleByResource[String(person.resourceName)] = normalized;
        });
      } catch (e) {
        Logger.log('Recent direct Chat People batch lookup failed: %s', e.message);
      }
    }

    const liveRows = [];
    spaces.forEach(function (space) {
      const resource = peerNames[space.name];
      if (!resource) return;
      const person = peopleByResource[resource] || {};
      const label = String(person.display_name || person.email || '').trim();
      if (!label) return;
      liveRows.push({
        space_name: String(space.name || ''),
        space_type: 'DIRECT_MESSAGE',
        label: label,
        peer_email: String(person.email || '').toLowerCase(),
        last_active_time: String(space.lastActiveTime || ''),
        updated_at: Repo.now()
      });
    });

    // Prefer live Google Chat recency, but keep previously-used sources as a
    // fallback so a useful conversation doesn't disappear just because it fell
    // outside the small live window.
    const combined = liveRows.concat(recentSources());
    const saved = saveRecentSources_(combined);
    return saved.slice(0, maxRows);
  }

  function rememberSource_(ctx) {
    if (!ctx || !ctx.space_name) return;
    const me = String(ctx.invoking_email || currentUserEmail_() || '').toLowerCase();
    const others = (ctx.participants || []).filter(function (p) {
      return p && p.email && String(p.email).toLowerCase() !== me;
    });
    const label = conversationLabel_({
      name: ctx.space_name,
      spaceType: ctx.space_type,
      displayName: ctx.space_display_name
    }, ctx.participants || [], me, ctx.invoking_user_name || '');
    const row = {
      space_name: String(ctx.space_name || ''),
      space_type: String(ctx.space_type || ''),
      label: String(label || ctx.space_display_name || 'Chat conversation'),
      peer_email: others.length === 1 ? String(others[0].email || '').toLowerCase() : '',
      updated_at: Repo.now()
    };
    let rows = recentSources().filter(function (r) { return String(r.space_name) !== row.space_name; });
    rows.unshift(row);
    rows = rows.slice(0, Math.max(1, Math.min(8, Number(CONFIG.CHAT_RECENT_SOURCE_LIMIT) || 5)));
    saveRecentSources_(rows);
  }

  function directoryPerson_(person) {
    person = person || {};
    const name = person.names && person.names.length ? String(person.names[0].displayName || '') : '';
    const emails = person.emailAddresses || [];
    const primary = emails.filter(function (x) { return x.metadata && x.metadata.primary; })[0] || emails[0] || {};
    return { display_name: name || String(primary.value || '').split('@')[0], email: String(primary.value || '').toLowerCase() };
  }

  function searchDirectoryPeople(query) {
    requireWriter_();
    query = String(query || '').trim();
    if (!query) return [];
    const limit = Math.max(1, Math.min(10, Number(CONFIG.CHAT_DIRECTORY_SEARCH_LIMIT) || 8));
    let rows = [];
    try {
      const path = 'people:searchDirectoryPeople?query=' + encodeURIComponent(query) +
        '&readMask=' + encodeURIComponent('names,emailAddresses') +
        '&sources=' + encodeURIComponent('DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE') +
        '&pageSize=' + limit;
      const out = peopleFetch_(path);
      rows = (out.people || []).map(directoryPerson_).filter(function (p) { return !!p.email; });
    } catch (e) {
      Logger.log('Directory people search failed: %s', e.message);
    }
    // Email is already a precise identifier. Keep it usable even if the
    // directory search index has not warmed for the account yet.
    if (!rows.length && /^[^@\s]+@[^@\s]+$/.test(query)) {
      rows = [{ display_name: query.split('@')[0], email: query.toLowerCase() }];
    }
    const seen = {};
    return rows.filter(function (p) {
      const key = String(p.email || '').toLowerCase();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    }).slice(0, limit);
  }

  function buildContextForDirectMessage(email, event) {
    requireWriter_();
    email = String(email || '').toLowerCase().trim();
    if (!email) throw new Error('Choose a coworker.');
    let space;
    try {
      space = chatFetch_('get', 'spaces:findDirectMessage?name=' + encodeURIComponent('users/' + email), null, ScriptApp.getOAuthToken());
    } catch (e) {
      throw new Error('Project Tracker could not find your 1:1 Google Chat with ' + email + '. If this is a group chat, use the message-link option instead. (' + e.message + ')');
    }
    if (!space || !space.name) throw new Error('No 1:1 Google Chat was found with ' + email + '.');
    return buildContextForSpace(space.name, event, null);
  }

  function listSourceConversations(event) {
    requireWriter_();
    const currentSpace = spaceNameFromEvent_(event);
    const me = String(Repo.me() || '').toLowerCase();
    const invoker = invokingUserFromEvent_(event);
    const meUserName = String(invoker && invoker.name || '');
    let token = '';
    const spaces = [];
    do {
      const opts = {
        pageSize: 100,
        filter: 'spaceType = "DIRECT_MESSAGE" OR spaceType = "GROUP_CHAT"'
      };
      if (token) opts.pageToken = token;
      const out = Chat.Spaces.list(opts);
      (out.spaces || []).forEach(function (space) {
        if (!space || !space.name || String(space.name) === String(currentSpace)) return;
        spaces.push(space);
      });
      token = String(out.nextPageToken || '');
    } while (token && spaces.length < 100);

    const rows = spaces.slice(0, 100).map(function (space) {
      const participants = listParticipants_(space.name, event);
      return {
        space_name: String(space.name || ''),
        space_type: String(space.spaceType || space.type || ''),
        display_name: String(space.displayName || ''),
        label: conversationLabel_(space, participants, me, meUserName),
        participants: participants
      };
    }).filter(function (row) { return !!row.space_name; });

    rows.sort(function (a, b) {
      return String(a.label || '').localeCompare(String(b.label || ''), undefined, { sensitivity: 'base' });
    });
    return rows.slice(0, Math.max(10, Math.min(60, Number(CONFIG.CHAT_SOURCE_CONVERSATION_LIMIT) || 40)));
  }

  function buildContextForSpace(spaceName, event, anchorMessage, options) {
    const startedAt = Date.now();
    options = options || {};
    requireWriter_();
    spaceName = String(spaceName || '').trim();
    if (!spaceName) throw new Error('Choose a Google Chat conversation.');
    let space = {};
    try { space = Chat.Spaces.get(spaceName); }
    catch (e) { throw new Error('Project Tracker could not open that Chat conversation. ' + e.message); }
    const afterSpace = Date.now();
    let messages = listRecentMessages_(spaceName, anchorMessage || null);
    const afterMessages = Date.now();
    const participants = listParticipants_(spaceName, event);
    const afterParticipants = Date.now();
    messages = enrichMessageSenders_(messages, participants);
    const me = String(Repo.me() || '').toLowerCase();
    const agents = {};
    Repo.activeAgents().forEach(function (a) { agents[String(a.email || '').toLowerCase()] = String(a.role || '').toLowerCase(); });
    participants.forEach(function (p) {
      p.is_me = !!p.email && p.email === me;
      p.project_tracker_role = agents[p.email] || '';
    });
    const ctx = {
      space_name: spaceName,
      space_type: String(space.spaceType || space.type || ''),
      space_display_name: String(space.displayName || ''),
      invoking_email: me,
      invoking_user_name: String(invokingUserFromEvent_(event).name || ''),
      anchor_message_name: String(anchorMessage && anchorMessage.name || ''),
      participants: participants,
      messages: messages,
      created_at: Repo.now()
    };
    // For Create Project, reserve before the first context persistence so the
    // dialog does not immediately read and rewrite the same durable context.
    if (options.reserve_create_ticket_id) {
      ctx.reserved_ticket_id = Repo.nextTicketId();
      ctx.reserved_ticket_reserved_at = Repo.now();
    }
    const afterReservation = Date.now();
    ctx.context_id = cacheContext_(ctx);
    rememberSource_(ctx);
    Logger.log('Chat context timing space=%sms messages=%sms participants=%sms reserve=%sms persist=%sms total=%sms',
      afterSpace - startedAt,
      afterMessages - afterSpace,
      afterParticipants - afterMessages,
      afterReservation - afterParticipants,
      Date.now() - afterReservation,
      Date.now() - startedAt);
    return ctx;
  }

  function contextPropertyBase_(id) {
    return CTX_PROP_PREFIX + String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function contextOwnerEmail_() {
    try { return String(Repo.me() || '').trim().toLowerCase(); } catch (ignore) { return ''; }
  }

  function contextEventUserName_(event) {
    try { return String(invokingUserFromEvent_(event).name || '').trim(); } catch (ignore) { return ''; }
  }

  function latestContextKey_(email) {
    return CTX_LATEST_PREFIX + String(email || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  }

  function latestContextUserKey_(userName) {
    return CTX_LATEST_USER_PREFIX + String(userName || '').replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function contextStore_() {
    // Google documents User Cache/User Properties as scoped to the current
    // user/effective user. Chat dialog callbacks can cross execution contexts,
    // so a user-scoped store is a fragile handoff mechanism here. Use the
    // script-scoped stores and protect each record with an unguessable UUID plus
    // the stable Chat user resource name captured from the event.
    return PropertiesService.getScriptProperties();
  }

  function cleanupDurableContexts_() {
    // Scanning every Script Property on every Chat card action is unnecessary
    // and can be slow once many durable contexts exist. Cleanup is housekeeping,
    // so run it at most once every five minutes per script instance.
    const cache = CacheService.getScriptCache();
    try {
      if (cache.get(CTX_CLEANUP_CACHE_KEY)) return;
      cache.put(CTX_CLEANUP_CACHE_KEY, '1', 300);
    } catch (ignore) {}
    const props = contextStore_();
    const all = props.getProperties();
    const now = Date.now();
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(CTX_PROP_PREFIX) !== 0 || !/_meta$/.test(key)) return;
      let meta = {};
      try { meta = JSON.parse(all[key] || '{}'); } catch (ignore) {}
      const created = Number(meta.created_at_ms) || 0;
      if (created && now - created <= CTX_DURABLE_MAX_AGE_MS) return;
      const base = key.substring(0, key.length - 5);
      const count = Math.max(0, Number(meta.chunks) || 0);
      props.deleteProperty(base + '_meta');
      for (let i = 0; i < count; i++) props.deleteProperty(base + '_' + i);
    });
  }

  function encodedContextParts_(raw) {
    const zipped = Utilities.gzip(Utilities.newBlob(String(raw || ''), 'application/json'));
    const encoded = Utilities.base64EncodeWebSafe(zipped.getBytes());
    const chunks = [];
    for (let i = 0; i < encoded.length; i += CTX_PROP_CHUNK_SIZE) chunks.push(encoded.substring(i, i + CTX_PROP_CHUNK_SIZE));
    return chunks;
  }

  function putDurableContext_(id, raw, ctx) {
    cleanupDurableContexts_();
    const props = contextStore_();
    const base = contextPropertyBase_(id);
    const chunks = encodedContextParts_(raw);
    const values = {};
    const ownerEmail = String(ctx && ctx.invoking_email || contextOwnerEmail_() || '').toLowerCase();
    const ownerUserName = String(ctx && ctx.invoking_user_name || '');
    values[base + '_meta'] = JSON.stringify({
      chunks: chunks.length,
      created_at_ms: Date.now(),
      owner_email: ownerEmail,
      owner_user_name: ownerUserName
    });
    chunks.forEach(function (chunk, i) { values[base + '_' + i] = chunk; });
    if (ownerEmail) values[latestContextKey_(ownerEmail)] = String(id || '');
    if (ownerUserName) values[latestContextUserKey_(ownerUserName)] = String(id || '');
    props.setProperties(values, false);
  }

  function getContextFromStore_(id) {
    const props = contextStore_();
    const base = contextPropertyBase_(id);
    const metaRaw = props.getProperty(base + '_meta');
    if (!metaRaw) return '';
    let meta = {};
    try { meta = JSON.parse(metaRaw); } catch (ignore) { return ''; }
    const created = Number(meta.created_at_ms) || 0;
    const count = Math.max(0, Number(meta.chunks) || 0);
    if (!count || !created || Date.now() - created > CTX_DURABLE_MAX_AGE_MS) return '';
    let encoded = '';
    for (let i = 0; i < count; i++) {
      const chunk = props.getProperty(base + '_' + i);
      if (chunk == null) return '';
      encoded += chunk;
    }
    try {
      const bytes = Utilities.base64DecodeWebSafe(encoded);
      return Utilities.ungzip(Utilities.newBlob(bytes)).getDataAsString();
    } catch (e) {
      Logger.log('Could not restore durable Chat context: %s', e.message);
      return '';
    }
  }

  function latestContextId_(event) {
    const props = contextStore_();
    const userName = contextEventUserName_(event);
    if (userName) {
      const byUser = String(props.getProperty(latestContextUserKey_(userName)) || '');
      if (byUser) return byUser;
    }
    const email = contextOwnerEmail_();
    if (email) {
      const byEmail = String(props.getProperty(latestContextKey_(email)) || '');
      if (byEmail) return byEmail;
    }
    return '';
  }

  function getDurableContext_(id) {
    try { return getContextFromStore_(id); }
    catch (e) {
      Logger.log('Chat context restore warning: %s', e.message);
      return '';
    }
  }

  function deleteContext_(id) {
    id = String(id || '');
    if (!id) return;
    try { CacheService.getScriptCache().remove(CTX_PREFIX + id); } catch (ignore) {}
    try {
      const props = contextStore_();
      const base = contextPropertyBase_(id);
      let count = 0;
      try { count = Number(JSON.parse(props.getProperty(base + '_meta') || '{}').chunks) || 0; } catch (ignore2) {}
      props.deleteProperty(base + '_meta');
      for (let i = 0; i < count; i++) props.deleteProperty(base + '_' + i);
    } catch (ignore3) {}
  }

  function cacheContext_(ctx) {
    const id = Utilities.getUuid();
    // Put the id inside the serialized payload before persisting it. Earlier
    // revisions assigned context_id only after JSON.stringify(), which made
    // restored contexts less self-describing and complicated recovery.
    ctx.context_id = id;
    const raw = JSON.stringify(ctx);
    try { CacheService.getScriptCache().put(CTX_PREFIX + id, raw, Number(CONFIG.CHAT_CONTEXT_CACHE_SECONDS) || 1200); } catch (ignore) {}
    putDurableContext_(id, raw, ctx);
    return id;
  }

  function getContext(contextId, event) {
    let id = String(contextId || '');
    if (!id) id = latestContextId_(event);
    if (!id) throw new Error('This Chat selection is no longer available. Reopen Create Project or Add to Project and try again.');

    let raw = '';
    try { raw = CacheService.getScriptCache().get(CTX_PREFIX + id) || ''; } catch (ignore) {}
    if (!raw) raw = getDurableContext_(id);

    // If Google omitted an action parameter, recover the latest context by the
    // stable Chat user resource name from the current event, not by the Apps
    // Script effective-user identity.
    if (!raw) {
      const latest = latestContextId_(event);
      if (latest && latest !== id) {
        id = latest;
        try { raw = CacheService.getScriptCache().get(CTX_PREFIX + id) || ''; } catch (ignore2) {}
        if (!raw) raw = getDurableContext_(id);
      }
    }
    if (!raw) {
      Logger.log('Chat context miss. requested=%s eventUser=%s activeUser=%s', String(contextId || ''), contextEventUserName_(event), contextOwnerEmail_());
      throw new Error('This Chat selection is no longer available. Reopen Create Project or Add to Project and try again.');
    }

    let ctx = null;
    try { ctx = JSON.parse(raw); } catch (e) { throw new Error('Project Tracker could not restore this Chat selection. Reopen the command and try again.'); }

    const eventUserName = contextEventUserName_(event);
    const ownerUserName = String(ctx && ctx.invoking_user_name || '');
    if (eventUserName && ownerUserName && eventUserName !== ownerUserName) {
      throw new Error('This Chat selection belongs to a different Project Tracker user. Reopen the command and try again.');
    }

    try { CacheService.getScriptCache().put(CTX_PREFIX + id, raw, Number(CONFIG.CHAT_CONTEXT_CACHE_SECONDS) || 1200); } catch (ignore3) {}
    return ctx;
  }

  function saveContext_(contextId, ctx) {
    let id = String(contextId || '');
    if (!id) id = String(ctx && ctx.context_id || '') || latestContextId_(null);
    if (!id) throw new Error('Missing Chat context id.');
    if (ctx && !ctx.context_id) ctx.context_id = id;
    const raw = JSON.stringify(ctx || {});
    try { CacheService.getScriptCache().put(CTX_PREFIX + id, raw, Number(CONFIG.CHAT_CONTEXT_CACHE_SECONDS) || 1200); } catch (ignore) {}
    putDurableContext_(id, raw, ctx || {});
    return ctx;
  }

  /**
   * Reserve the ticket number while the dialog is being built, not when the
   * user presses Create. Chat submit callbacks have a very small practical
   * latency budget; moving the Meta read/write here removes one spreadsheet
   * round trip from the critical create action. Gaps are harmless if a user
   * later cancels the dialog.
   */
  function reserveCreateTicketId(contextId) {
    requireWriter_();
    const ctx = getContext(contextId);
    if (ctx.reserved_ticket_id) return String(ctx.reserved_ticket_id);
    ctx.reserved_ticket_id = Repo.nextTicketId();
    ctx.reserved_ticket_reserved_at = Repo.now();
    saveContext_(contextId, ctx);
    return String(ctx.reserved_ticket_id);
  }

  function parseSpaceNameFromMessageLink_(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    let m = text.match(/^spaces\/([A-Za-z0-9_-]+)$/i);
    if (m) return 'spaces/' + m[1];
    // Common Google Chat / Gmail Chat message-link shapes contain one of
    // /room/{spaceId}, /space/{spaceId}, or /dm/{spaceId}.
    m = text.match(/(?:^|[\/#])(?:room|space|dm)\/([A-Za-z0-9_-]+)/i);
    if (m) return 'spaces/' + m[1];
    if (/^[A-Za-z0-9_-]{8,}$/.test(text)) return 'spaces/' + text;
    return '';
  }

  function buildContextFromMessageLink(value, event) {
    requireWriter_();
    const spaceName = parseSpaceNameFromMessageLink_(value);
    if (!spaceName) {
      throw new Error('That does not look like a Google Chat message link. In the coworker Chat, use \u22ee > Copy message link and paste it here.');
    }
    return buildContextForSpace(spaceName, event, null);
  }

  function buildContext(event) {
    requireWriter_();
    const spaceName = spaceNameFromEvent_(event);
    if (!spaceName) throw new Error('Project Tracker could not identify this Chat conversation.');
    return buildContextForSpace(spaceName, event, anchorMessageFromEvent_(event));
  }

  function selectedMessages_(ctx, names) {
    names = Array.isArray(names) ? names : [names];
    const wanted = {};
    names.filter(Boolean).forEach(function (n) { wanted[String(n)] = true; });
    const rows = (ctx.messages || []).filter(function (m) { return wanted[m.name]; });
    rows.sort(function (a, b) { return String(a.create_time).localeCompare(String(b.create_time)); });
    return rows;
  }

  function mediaDownload_(resourceName) {
    const rn = String(resourceName || '').replace(/^\//, '');
    if (!rn) throw new Error('Missing Chat attachment resource name.');
    const url = 'https://chat.googleapis.com/v1/media/' + rn.replace(/^media\//, '') + '?alt=media';
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
      throw new Error('Chat attachment download failed (' + response.getResponseCode() + ').');
    }
    return response.getBlob();
  }

  function filesForMessage_(message) {
    const files = [], drive = [], skipped = [], inlineTokens = [];
    let total = 0;
    (message.attachments || []).forEach(function (a, index) {
      if (a.source === 'DRIVE_FILE' && a.drive_file_id) {
        drive.push(a);
        return;
      }
      if (!a.attachment_resource_name) {
        skipped.push(a.content_name || 'Attachment');
        return;
      }
      try {
        const blob = mediaDownload_(a.attachment_resource_name);
        const bytes = blob.getBytes();
        const name = a.content_name || blob.getName() || ('Chat attachment ' + (index + 1));
        if (bytes.length > CONFIG.MAX_ATTACHMENT_FILE_BYTES) {
          skipped.push(name + ' (larger than ' + Math.round(CONFIG.MAX_ATTACHMENT_FILE_BYTES / 1048576) + ' MB)');
          return;
        }
        if (total + bytes.length > CONFIG.MAX_TOTAL_INLINE_BYTES) {
          skipped.push(name + ' (Chat files exceeded the per-message upload limit)');
          return;
        }
        total += bytes.length;
        const mime = String(a.content_type || blob.getContentType() || 'application/octet-stream');
        const inline = /^image\//i.test(mime);
        const tempId = 'chat_' + Utilities.getUuid().replace(/-/g, '');
        files.push({
          temp_id: tempId,
          name: name,
          original_name: name,
          mime_type: mime,
          inline: inline,
          base64: Utilities.base64Encode(bytes)
        });
        if (inline) inlineTokens.push('[imgtmp:' + tempId + ']');
      } catch (e) {
        skipped.push((a.content_name || 'Attachment') + ' — ' + e.message);
      }
    });
    return { files: files, drive: drive, skipped: skipped, inlineTokens: inlineTokens };
  }

  function attachmentMeta_(attachment) {
    attachment = attachment || {};
    return {
      content_name: String(attachment.content_name || ''),
      content_type: String(attachment.content_type || ''),
      source: String(attachment.source || ''),
      drive_file_id: String(attachment.drive_file_id || ''),
      attachment_resource_name: String(attachment.attachment_resource_name || '')
    };
  }

  function refForMessage_(ctx, message, batchId, postprocessState) {
    const meta = {
      source: 'google_chat',
      batch_id: batchId,
      space_name: ctx.space_name,
      space_type: ctx.space_type,
      space_display_name: ctx.space_display_name,
      message_name: message.name,
      thread_name: message.thread_name || '',
      sender_name: message.sender && message.sender.display_name || '',
      sender_email: message.sender && message.sender.email || '',
      sender_user_name: message.sender && message.sender.user_name || '',
      originator_email: String(ctx.invoking_email || currentUserEmail_() || '').toLowerCase(),
      postprocess_state: String(postprocessState || 'pending'),
      attachments: dedupeAttachments_(message.attachments || []).map(attachmentMeta_)
    };
    return 'gchat:' + JSON.stringify(meta);
  }

  function parseChatRef_(ref) {
    if (String(ref || '').indexOf('gchat:') !== 0) return null;
    try { return JSON.parse(String(ref).substring(6)); }
    catch (e) { return null; }
  }

  function refWithState_(ref, state, extra) {
    const meta = parseChatRef_(ref) || {};
    meta.postprocess_state = String(state || 'done');
    Object.keys(extra || {}).forEach(function (key) { meta[key] = extra[key]; });
    return 'gchat:' + JSON.stringify(meta);
  }

  function existingMessageNames_(ticketId) {
    const out = {};
    Repo.findAll(TABS.ACTIVITY, 'ticket_id', ticketId).forEach(function (a) {
      if (a.kind !== ACTIVITY_KIND.CHAT || String(a.ref || '').indexOf('gchat:') !== 0) return;
      // Only a currently-visible Chat activity should block a re-import. If an
      // imported message/conversation was soft-deleted from Project Tracker,
      // the user must be able to add that same Google Chat message again later.
      if (a.deleted === true || a.deleted === 'TRUE') return;
      try {
        const meta = JSON.parse(String(a.ref).substring(6));
        if (meta.message_name) out[String(meta.message_name)] = true;
      } catch (ignore) {}
    });
    return out;
  }


  function normalizeOwnersForFastCreate_(value, user) {
    const allowed = {};
    Repo.activeAgents().forEach(function (a) {
      if (String(a.role || '').toLowerCase() === 'agent') allowed[String(a.email || '').toLowerCase()] = true;
    });
    let owners = String(value || '').split(',').map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean);
    if (!owners.length && allowed[String(user.email || '').toLowerCase()]) owners = [String(user.email).toLowerCase()];
    owners = owners.filter(function (email, i, arr) { return arr.indexOf(email) === i; });
    if (!owners.length) throw new Error('Choose a ticket owner.');
    owners.forEach(function (email) {
      if (!allowed[email]) throw new Error('Tickets can only be assigned to active Project Tracker agents.');
    });
    return owners.join(',');
  }

  function formatTicketId_(n) {
    let text = String(Number(n) || 0);
    while (text.length < Number(CONFIG.TICKET_PAD || 4)) text = '0' + text;
    return String(CONFIG.TICKET_PREFIX || 'TKT-') + text;
  }

  function pendingCreateEffectsRows_() {
    try {
      const raw = PropertiesService.getUserProperties().getProperty(PENDING_CREATE_EFFECTS_KEY);
      const rows = raw ? JSON.parse(raw) : [];
      return Array.isArray(rows) ? rows : [];
    } catch (e) { return []; }
  }

  function savePendingCreateEffectsRows_(rows) {
    const props = PropertiesService.getUserProperties();
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) props.deleteProperty(PENDING_CREATE_EFFECTS_KEY);
    else props.setProperty(PENDING_CREATE_EFFECTS_KEY, JSON.stringify(rows.slice(0, 100)));
  }

  function queueCreateEffects_(ticket) {
    let rows = pendingCreateEffectsRows_().filter(function (x) { return String(x.ticket_id || '') !== String(ticket.ticket_id || ''); });
    rows.unshift({ ticket_id: ticket.ticket_id, created_by: ticket.created_by, owners: ticket.owners, title: ticket.title, queued_at: Repo.now() });
    savePendingCreateEffectsRows_(rows);
  }

  function processPendingCreateEffects_(ticketId) {
    requireWriter_();
    const wanted = String(ticketId || '');
    const rows = pendingCreateEffectsRows_();
    if (!rows.length) return { checked: 0, processed: 0, errors: [] };
    const keep = [], errors = [];
    let processed = 0;
    rows.forEach(function (row) {
      if (wanted && String(row.ticket_id || '') !== wanted) { keep.push(row); return; }
      try {
        const existing = Repo.findAll(TABS.NOTIFICATIONS, 'ticket_id', row.ticket_id);
        const seen = {};
        existing.forEach(function (n) {
          if (String(n.kind || '') === 'assignment') seen[String(n.user_email || '').toLowerCase()] = true;
        });
        const creator = String(row.created_by || '').toLowerCase();
        String(row.owners || '').split(',').map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean).forEach(function (email) {
          if (email === creator || seen[email]) return;
          Repo.append(TABS.NOTIFICATIONS, {
            notification_id: Utilities.getUuid(), user_email: email, ticket_id: row.ticket_id,
            timestamp: Repo.now(), actor: creator, kind: 'assignment',
            body: 'You were assigned to this ticket.', read_at: '', title: row.title || row.ticket_id, archived_at: ''
          });
          seen[email] = true;
        });
        // The fast Chat create path deliberately avoids extra sheet/API work in
        // the interactive callback. Record its workload-study creation event here
        // during deferred post-processing instead, preserving Chat responsiveness.
        if (typeof WorkloadStudy !== 'undefined') {
          const studyTicket = Repo.findOne(TABS.TICKETS, 'ticket_id', row.ticket_id);
          if (studyTicket) WorkloadStudy.recordTicketCreated(studyTicket, 'google_chat', creator);
        }
        processed++;
      } catch (e) {
        keep.push(row);
        errors.push({ ticket_id: row.ticket_id, message: e.message });
      }
    });
    savePendingCreateEffectsRows_(keep);
    return { checked: rows.length, processed: processed, errors: errors };
  }

  /**
   * Minimal Chat create path. It writes the ticket and every selected Chat
   * activity using one Spreadsheet object and one short script lock. Expensive
   * assignment notifications, attachment downloads, and enrichment are deferred
   * to the normal web/hourly post-processing path.
   */
  function createTicketWithMessagesFast(payload, contextId, messageNames) {
    const started = Date.now();
    const user = requireWriter_();
    const ctx = getContext(contextId);
    const messages = selectedMessages_(ctx, messageNames);
    if (!messages.length) throw new Error('Select at least one Chat message.');
    let ticketId = String(ctx.reserved_ticket_id || '');
    if (!ticketId) throw new Error('This Create Project form predates the fast Chat writer. Close it, reopen Create Project, and try again.');
    const owners = normalizeOwnersForFastCreate_(payload.owners, user);
    const now = Repo.now();
    const ticket = {
      ticket_id: ticketId,
      title: String(payload.title || '(untitled)'),
      description: String(payload.description || ''),
      type: String(payload.type || ''),
      department: String(payload.department || ''),
      status: String(payload.status || STATUS.IN_PROGRESS),
      substatus: '', owners: owners, size: String(payload.size || 'M'), progress: 0,
      created_by: user.email, created_at: now, updated_at: now, last_activity_at: now,
      due_date: '', waiting_who: '', waiting_what: '', waiting_since: '', drive_folder_id: '',
      halt_reason: '', halt_note: '', completed_at: '', deleted: false, deleted_at: '',
      high_priority: false, priority_by: '', priority_at: '', description_markup: String(payload.description || '')
    };
    const batchId = Utilities.getUuid();
    const activities = [{
      activity_id: Utilities.getUuid(), ticket_id: ticketId, timestamp: now, actor: user.email,
      kind: ACTIVITY_KIND.CHANGE, body: 'created this ticket', ref: 'ptsource:google_chat', parent_activity_id: '',
      edited_at: '', deleted: false, deleted_at: '', body_markup: ''
    }];
    messages.forEach(function (message) {
      const attachmentNames = (message.attachments || []).map(function (a) { return String(a.content_name || 'Attachment'); }).filter(Boolean);
      let text = String(message.text || '').trim();
      if (!text && attachmentNames.length) text = 'Shared ' + attachmentNames.join(', ');
      if (!text) text = '(Google Chat message)';
      let activityAt = now;
      if (message.create_time) {
        const parsed = new Date(message.create_time);
        if (!isNaN(parsed.getTime())) activityAt = parsed.toISOString();
      }
      activities.push({
        activity_id: Utilities.getUuid(), ticket_id: ticketId, timestamp: activityAt,
        actor: String(message.sender && (message.sender.email || message.sender.user_name) || 'google-chat'),
        kind: ACTIVITY_KIND.CHAT, body: text, ref: refForMessage_(ctx, message, batchId, 'pending'),
        parent_activity_id: '', edited_at: '', deleted: false, deleted_at: '', body_markup: text
      });
    });

    const spreadsheetId = String(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '').trim();
    if (!spreadsheetId) throw new Error('Project Tracker spreadsheet is not configured.');
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(1200)) throw new Error('Project Tracker is busy. Try creating the project again.');
    try {
      const book = SpreadsheetApp.openById(spreadsheetId);
      const ticketSheet = book.getSheetByName(TABS.TICKETS);
      const activitySheet = book.getSheetByName(TABS.ACTIVITY);
      if (!ticketSheet || !activitySheet) throw new Error('Project Tracker data sheets are missing.');
      const ticketHeaders = SCHEMA[TABS.TICKETS];
      const activityHeaders = SCHEMA[TABS.ACTIVITY];
      const ticketRow = ticketHeaders.map(function (h) { return ticket[h] === undefined || ticket[h] === null ? '' : ticket[h]; });
      const activityRows = activities.map(function (a) { return activityHeaders.map(function (h) { return a[h] === undefined || a[h] === null ? '' : a[h]; }); });
      ticketSheet.getRange(ticketSheet.getLastRow() + 1, 1, 1, ticketHeaders.length).setValues([ticketRow]);
      activitySheet.getRange(activitySheet.getLastRow() + 1, 1, activityRows.length, activityHeaders.length).setValues(activityRows);
    } finally {
      lock.releaseLock();
    }
    Repo.cacheRemove('tickets_idx');
    queueCreateEffects_(ticket);
    Logger.log('Fast Chat create %s finished in %sms (%s Chat messages).', ticketId, Date.now() - started, messages.length);
    return { ticket: ticket, imported: messages.length, postprocessPending: messages.length };
  }

  function importMessages(ticketId, contextId, messageNames, options) {
    requireWriter_();
    options = options || {};
    if (!options.newTicket) {
      const ticket = Repo.findOne(TABS.TICKETS, 'ticket_id', ticketId);
      if (!ticket) throw new Error('Project not found.');
      if (ticket.deleted === true || ticket.deleted === 'TRUE') throw new Error('Restore this project before adding Chat messages.');
    }
    const ctx = getContext(contextId);
    const messages = selectedMessages_(ctx, messageNames);
    if (!messages.length) throw new Error('Select at least one Chat message.');

    // A just-created ticket cannot contain duplicate Chat messages yet. Skipping
    // the Activity scan saves a full spreadsheet read inside Chat's short action callback.
    const existing = options.newTicket ? {} : existingMessageNames_(ticketId);
    const batchId = Utilities.getUuid();
    const skippedDuplicates = [];
    const now = Repo.now();
    const entries = [];

    // IMPORTANT: save every selected Chat message in one sheet write before
    // doing any attachment downloads or Element451 enrichment. Chat dialog
    // callbacks have a tight runtime budget; this prevents a slow image/API
    // lookup from leaving a half-imported transcript.
    messages.forEach(function (message) {
      if (existing[message.name]) {
        skippedDuplicates.push(message.name);
        return;
      }
      const attachmentNames = (message.attachments || []).map(function (a) {
        return String(a.content_name || 'Attachment');
      }).filter(Boolean);
      let text = String(message.text || '').trim();
      if (!text && attachmentNames.length) text = 'Shared ' + attachmentNames.join(', ');
      if (!text) text = '(Google Chat message)';

      let activityAt = now;
      if (message.create_time) {
        const parsed = new Date(message.create_time);
        if (!isNaN(parsed.getTime())) activityAt = parsed.toISOString();
      }
      const activityId = Utilities.getUuid();
      entries.push({
        activity_id: activityId,
        ticket_id: ticketId,
        timestamp: activityAt,
        actor: String(message.sender && (message.sender.email || message.sender.user_name) || 'google-chat'),
        kind: ACTIVITY_KIND.CHAT,
        body: text,
        ref: refForMessage_(ctx, message, batchId, 'pending'),
        parent_activity_id: '',
        edited_at: '',
        deleted: false,
        deleted_at: '',
        body_markup: text
      });
      existing[message.name] = true;
    });

    if (entries.length) {
      Repo.appendMany(TABS.ACTIVITY, entries);
      // Tickets.create() already stamped a new ticket with the current activity time,
      // so avoid another spreadsheet update during the Chat create callback.
      if (!options.newTicket) Repo.update(TABS.TICKETS, 'ticket_id', ticketId, { last_activity_at: now, updated_at: now });
    }

    // Do not inspect/create triggers here. Images/resources are picked up by the
    // existing unified hourly job and, more importantly, automatically when the
    // ticket is opened in the web dashboard.

    return {
      entries: entries,
      imported: entries.length,
      duplicateMessagesSkipped: skippedDuplicates.length,
      postprocessPending: entries.length
    };
  }


  function chatStudentUrlRefs_(text) {
    const out = [], seen = {}, re = /https?:\/\/[^\s<>\"]+/ig;
    let match;
    while ((match = re.exec(String(text || ''))) !== null && out.length < 40) {
      const literal = String(match[0] || '').replace(/[),.;!?]+$/g, '');
      const id = element451ExtractPersonId_(literal);
      if (!id || seen[id + '|' + literal.toLowerCase()]) continue;
      seen[id + '|' + literal.toLowerCase()] = true;
      out.push({ literal: literal, element_id: id, source: 'google_chat_url' });
    }
    return out;
  }

  function mergeStudentRefs_(left, right) {
    const out = [], seen = {};
    (left || []).concat(right || []).forEach(function (ref) {
      const literal = String(ref && ref.literal || '').trim();
      const id = String(ref && ref.element_id || '').trim().toLowerCase();
      if (!literal || !id) return;
      const key = literal.toLowerCase() + '|' + id;
      if (seen[key]) return;
      seen[key] = true;
      out.push({ literal: literal, element_id: id, source: String(ref.source || '') });
    });
    return out;
  }

  function activeChatActivities_(ticketId, limit, sourceRows) {
    const finder = Repo.findAllFast || Repo.findAll;
    const rows = Array.isArray(sourceRows) ? sourceRows : finder(TABS.ACTIVITY, 'ticket_id', ticketId);
    return rows.filter(function (a) {
      if (a.kind !== ACTIVITY_KIND.CHAT) return false;
      if (a.deleted === true || a.deleted === 'TRUE') return false;
      const meta = parseChatRef_(a.ref);
      return !!(meta && meta.source === 'google_chat');
    }).sort(function (a, b) {
      return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    }).slice(-Math.max(1, Number(limit) || 100));
  }

  /**
   * Google Chat student profile URLs are high-confidence identifiers. The Gmail
   * batch resolver is still used for configured external IDs and names, but Chat also
   * resolves profile URLs through the same direct Element-ID path as manual
   * "Add Student by URL". This is intentionally run outside the short Chat
   * callback, so reliability is more important than shaving off an API call.
   *
   * It also repairs older Chat activities that were previously marked done
   * while their student URL was still plain text.
   */
  function repairChatStudentUrlsForTicket_(ticketId, chatRows, errors, studentRows) {
    chatRows = chatRows || [];
    const refs = chatStudentUrlRefs_(chatRows.map(function (a) {
      return String(a.body || '') + '\n' + String(a.body_markup || '');
    }).join('\n'));
    if (!refs.length) return { refs: [], resolved: 0, tokenized: 0 };

    // Only ACTIVE relationships count as known here. Historical/soft-removed
    // student rows are intentionally excluded: an explicit student URL in a
    // newly imported Chat message should restore that student to the sidebar.
    // listForTokens() includes removed rows, which previously caused Chat to
    // think the student was already related while the Related Students card
    // remained empty and the URL could not tokenize.
    const known = {};
    try {
      if (Array.isArray(studentRows)) {
        studentRows.forEach(function (s) {
          if (bool_(s.removed)) return;
          const id = String(s.element_id || '').toLowerCase();
          if (id) known[id] = true;
        });
      } else {
        (RelatedStudents.list(ticketId) || []).forEach(function (s) {
          const id = String(s.element_id || '').toLowerCase();
          if (id) known[id] = true;
        });
      }
    } catch (ignore) {}

    let resolved = 0;
    const usableRefs = [];
    const byId = {};
    refs.forEach(function (ref) {
      (byId[ref.element_id] || (byId[ref.element_id] = [])).push(ref);
    });

    Object.keys(byId).forEach(function (id) {
      if (!known[id]) {
        try {
          // Use the exact same path as the manual "Add Student by URL" flow.
          // Besides using the proven Element-ID lookup, addByUrl() restores a
          // previously soft-removed relationship when the student is explicitly
          // referenced again in a new Chat import.
          const literal = String((byId[id] && byId[id][0] && byId[id][0].literal) || '');
          const added = RelatedStudents.addByUrl(ticketId, literal);
          if (added && added.student) {
            known[id] = true;
            if (added.added) resolved++;
          }
        } catch (e) {
          (errors || []).push({ ticket_id: ticketId, step: 'student_url', element_id: id, message: e.message });
        }
      }
      if (known[id]) Array.prototype.push.apply(usableRefs, byId[id]);
    });

    let tokenized = 0;
    if (usableRefs.length && typeof GmailTicketing !== 'undefined') {
      chatRows.forEach(function (activity) {
        try {
          const current = String(activity.body_markup || activity.body || '');
          const tagged = GmailTicketing.tokenizeImportedReferences(ticketId, current, usableRefs);
          if (tagged !== current) {
            Repo.update(TABS.ACTIVITY, 'activity_id', activity.activity_id, { body_markup: tagged });
            activity.body_markup = tagged;
            tokenized++;
          }
        } catch (e) {
          (errors || []).push({ activity_id: activity.activity_id, step: 'student_tokenize_repair', message: e.message });
        }
      });
    }
    return { refs: usableRefs, resolved: resolved, tokenized: tokenized };
  }

  /**
   * Repair the historical Google Chat attachment race that could upload one
   * non-inline file twice for the same imported message. Only exact same-name,
   * same-MIME attachments on the same immutable Chat activity are collapsed.
   * Inline images are deliberately excluded because their markup contains an
   * explicit resource ID and requires a different rewrite strategy.
   */
  function repairDuplicateChatAttachmentsForTicket_(ticketId, chatRows, resourceRows) {
    const chatIds = {};
    (Array.isArray(chatRows) ? chatRows : activeChatActivities_(ticketId, 250)).forEach(function (a) { chatIds[String(a.activity_id || '')] = true; });
    if (!Object.keys(chatIds).length) return 0;

    const resourceFinder = Repo.findAllFast || Repo.findAll;
    const rows = (Array.isArray(resourceRows) ? resourceRows : resourceFinder(TABS.RELATED_RESOURCES, 'ticket_id', ticketId)).filter(function (r) {
      if (!chatIds[String(r.activity_id || '')]) return false;
      if (r.removed === true || r.removed === 'TRUE') return false;
      return String(r.resource_type || '').toLowerCase() === 'attachment';
    }).sort(function (a, b) {
      return String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.resource_id || '').localeCompare(String(b.resource_id || ''));
    });

    const seen = {}, patches = {}, now = Repo.now();
    rows.forEach(function (r) {
      const key = String(r.activity_id || '') + '|' + String(r.name || '').trim().toLowerCase() + '|' + String(r.mime_type || '').trim().toLowerCase();
      if (!seen[key]) { seen[key] = r; return; }
      patches[String(r.resource_id)] = {
        removed: true,
        removed_at: now,
        parent_resource_id: '',
        depth: 0,
        updated_at: now
      };
    });
    const ids = Object.keys(patches);
    if (ids.length) Repo.updateMany(TABS.RELATED_RESOURCES, 'resource_id', patches);
    return ids.length;
  }

  function pendingImportedActivities_(ticketId, limit, sourceRows) {
    const me = currentUserEmail_();
    const finder = Repo.findAllFast || Repo.findAll;
    const rows = Array.isArray(sourceRows) ? sourceRows : (ticketId ? finder(TABS.ACTIVITY, 'ticket_id', ticketId) : Repo.readAll(TABS.ACTIVITY));
    return rows.filter(function (a) {
      if (a.kind !== ACTIVITY_KIND.CHAT) return false;
      if (a.deleted === true || a.deleted === 'TRUE') return false;
      const meta = parseChatRef_(a.ref);
      if (!meta || meta.source !== 'google_chat') return false;
      if (String(meta.postprocess_state || 'pending') === 'done') return false;
      if (meta.originator_email && me && String(meta.originator_email).toLowerCase() !== me) return false;
      return true;
    }).sort(function (a, b) {
      return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    }).slice(0, Math.max(1, Number(limit) || 20));
  }

  function existingActivityResourceKeys_(ticketId, activityId) {
    const out = {};
    try {
      RelatedResources.listAll(ticketId).forEach(function (r) {
        if (String(r.activity_id || '') !== String(activityId || '')) return;
        if (r.name) out['name:' + String(r.name).toLowerCase()] = true;
        if (r.drive_file_id) out['drive:' + String(r.drive_file_id)] = true;
      });
    } catch (ignore) {}
    return out;
  }

  function postprocessImportedAttachments_(activity, meta) {
    const ticketId = String(activity.ticket_id || '');
    const activityId = String(activity.activity_id || '');
    const attachments = dedupeAttachments_(Array.isArray(meta.attachments) ? meta.attachments : []);
    if (!attachments.length) return activity;
    const existing = existingActivityResourceKeys_(ticketId, activityId);
    const remaining = attachments.filter(function (a) {
      if (a.drive_file_id && existing['drive:' + String(a.drive_file_id)]) return false;
      if (a.content_name && existing['name:' + String(a.content_name).toLowerCase()]) return false;
      return true;
    });
    if (!remaining.length) return activity;

    const set = filesForMessage_({ attachments: remaining });
    let body = String(activity.body || '');
    let markup = String(activity.body_markup || activity.body || '');
    if (set.skipped.length) {
      const line = 'Attachments not imported: ' + set.skipped.join('; ');
      body += (body ? '\n\n' : '') + line;
      markup += (markup ? '\n\n' : '') + line;
    }
    if (set.inlineTokens.length) markup += (markup ? '\n' : '') + set.inlineTokens.join('\n');
    if (set.files.length) {
      const uploaded = RelatedResources.uploadForActivity(ticketId, activityId, set.files);
      markup = RelatedResources.replaceTempImageTokens(markup, uploaded.tempMap || {});
    }
    set.drive.forEach(function (a) {
      try {
        const r = RelatedResources.addExistingDriveFile(ticketId, activityId, a.drive_file_id, 'google_chat_drive');
        if (r && r.resource_type === 'inline_image' && r.resource_id) markup += (markup.trim() ? '\n' : '') + '[img:' + r.resource_id + ']';
      } catch (e) { Logger.log('Chat Drive attachment skipped: %s', e.message); }
    });
    const updated = Repo.update(TABS.ACTIVITY, 'activity_id', activityId, { body: body, body_markup: markup }) || activity;
    try { repairDuplicateChatAttachmentsForTicket_(ticketId); } catch (ignore) {}
    return updated;
  }

  function processPendingImportsForTicket(ticketId, limit, context) {
    requireWriter_();
    context = context || {};
    let createEffects = { checked: 0, processed: 0, errors: [] };
    try { createEffects = processPendingCreateEffects_(ticketId) || createEffects; }
    catch (e) { Logger.log('Pending Chat create effects failed for %s: %s', ticketId, e.message); }

    const errors = [];
    const activityRows = Array.isArray(context.activityRows) ? context.activityRows : null;
    const allChatRows = activeChatActivities_(ticketId, 150, activityRows);
    const dedupeChatRows = activeChatActivities_(ticketId, 250, activityRows);
    const studentRepair = repairChatStudentUrlsForTicket_(ticketId, allChatRows, errors, context.studentRows);
    let duplicateAttachmentsRemoved = 0;
    try { duplicateAttachmentsRemoved = repairDuplicateChatAttachmentsForTicket_(ticketId, dedupeChatRows, context.resourceRows); }
    catch (e) { errors.push({ ticket_id: ticketId, step: 'attachment_dedupe', message: e.message }); }

    // When the caller already loaded this ticket's Activity rows (the dashboard
    // sync path does), reuse that snapshot for the pending scan instead of
    // rereading Activity several times in the same execution.
    const rows = pendingImportedActivities_(ticketId, limit || 20, activityRows);
    if (!rows.length) {
      return {
        checked: 0,
        processed: 0,
        errors: errors,
        createEffectsProcessed: Number(createEffects.processed || 0),
        studentUrlsResolved: Number(studentRepair.resolved || 0),
        studentChatRowsRetagged: Number(studentRepair.tokenized || 0),
        duplicateAttachmentsRemoved: duplicateAttachmentsRemoved
      };
    }

    const processedRows = rows.map(function (activity) {
      try { return postprocessImportedAttachments_(activity, parseChatRef_(activity.ref) || {}) || activity; }
      catch (e) { errors.push({ activity_id: activity.activity_id, step: 'attachments', message: e.message }); return activity; }
    });

    let enrichment = { studentRefs: (studentRepair.refs || []).slice() }, enrichmentOk = true;
    if (typeof GmailTicketing !== 'undefined') {
      try {
        const normal = GmailTicketing.enrichImportedText(ticketId, processedRows.map(function (a) { return String(a.body || ''); }).join('\n\n')) || { studentRefs: [] };
        enrichment.studentRefs = mergeStudentRefs_(enrichment.studentRefs, normal.studentRefs || []);
      }
      catch (e) { enrichmentOk = false; errors.push({ ticket_id: ticketId, step: 'enrichment', message: e.message }); }
    }

    let processed = 0;
    processedRows.forEach(function (activity) {
      try {
        let markup = String(activity.body_markup || activity.body || '');
        if (typeof GmailTicketing !== 'undefined') markup = GmailTicketing.tokenizeImportedReferences(ticketId, markup, enrichment.studentRefs || []);
        const patch = { body_markup: markup };
        // Direct student-URL repair is independent of the broader Gmail-style
        // enrichment. If the broader pass failed, keep this activity pending so
        // External-ID/resource enrichment can retry later, but preserve any
        // student URL token that was already repaired.
        if (enrichmentOk) patch.ref = refWithState_(activity.ref, 'done', { postprocessed_at: Repo.now() });
        Repo.update(TABS.ACTIVITY, 'activity_id', activity.activity_id, patch);
        if (enrichmentOk) processed++;
      } catch (e) { errors.push({ activity_id: activity.activity_id, step: 'tokenize', message: e.message }); }
    });

    // Resources may have been created above, so this final repair intentionally
    // uses fresh sheet data rather than the caller's pre-processing snapshot.
    try { duplicateAttachmentsRemoved += repairDuplicateChatAttachmentsForTicket_(ticketId); } catch (ignore) {}
    return {
      checked: rows.length,
      processed: processed,
      errors: errors,
      createEffectsProcessed: Number(createEffects.processed || 0),
      studentUrlsResolved: Number(studentRepair.resolved || 0),
      studentChatRowsRetagged: Number(studentRepair.tokenized || 0),
      duplicateAttachmentsRemoved: duplicateAttachmentsRemoved
    };
  }

  function processPendingImports(limit) {
    requireWriter_();
    const rows = pendingImportedActivities_('', Math.max(1, Number(limit) || 30));
    const byTicket = {};
    rows.forEach(function (a) { if (a.ticket_id) (byTicket[a.ticket_id] || (byTicket[a.ticket_id] = [])).push(a); });
    const result = { checked: rows.length, processed: 0, tickets: 0, errors: [] };
    Object.keys(byTicket).forEach(function (ticketId) {
      const out = processPendingImportsForTicket(ticketId, byTicket[ticketId].length);
      result.tickets++; result.processed += Number(out.processed || 0); result.errors = result.errors.concat(out.errors || []);
    });
    return result;
  }

  function ensureViewerAccess(emails, participants) {
    requireWriter_();
    emails = Array.isArray(emails) ? emails : [emails];
    participants = participants || [];
    const names = {};
    participants.forEach(function (p) { if (p.email) names[String(p.email).toLowerCase()] = p.display_name || ''; });
    const all = Repo.readAll(TABS.AGENTS);
    const byEmail = {};
    all.forEach(function (a) { byEmail[String(a.email || '').toLowerCase()] = a; });
    const changed = [];

    emails.map(function (x) { return String(x || '').toLowerCase().trim(); }).filter(Boolean).forEach(function (email) {
      if (!projectTrackerEmailAllowed_(email)) throw new Error('Viewer access can only be granted to an email in CONFIG.ALLOWED_VIEWER_DOMAINS.');
      const row = byEmail[email];
      if (row) {
        const role = String(row.role || '').toLowerCase();
        const active = bool_(row.active);
        if (active) return;
        if (role === 'viewer') {
          Repo.update(TABS.AGENTS, 'email', row.email, { active: true, display_name: row.display_name || names[email] || email.split('@')[0] });
          changed.push(email);
          return;
        }
        throw new Error((row.display_name || email) + ' already has an inactive ' + role + ' Project Tracker row. Reactivate that row manually.');
      }
      Repo.append(TABS.AGENTS, {
        email: email,
        display_name: names[email] || email.split('@')[0],
        role: 'viewer',
        active: true
      });
      changed.push(email);
    });
    if (changed.length) Repo.invalidateAll();
    return changed;
  }

  function missingViewerEmails(ctx) {
    const agents = {};
    Repo.activeAgents().forEach(function (a) { agents[String(a.email || '').toLowerCase()] = String(a.role || '').toLowerCase(); });
    return (ctx.participants || []).filter(function (p) {
      return p.email && !p.is_me && !agents[String(p.email).toLowerCase()];
    }).map(function (p) { return p.email; });
  }

  function pendingSharingRows_() {
    try {
      const raw = PropertiesService.getUserProperties().getProperty(PENDING_SHARING_KEY);
      const rows = raw ? JSON.parse(raw) : [];
      return Array.isArray(rows) ? rows : [];
    } catch (e) { return []; }
  }

  function savePendingSharingRows_(rows) {
    const props = PropertiesService.getUserProperties();
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) props.deleteProperty(PENDING_SHARING_KEY);
    else props.setProperty(PENDING_SHARING_KEY, JSON.stringify(rows.slice(0, 100)));
  }

  // Fast queue used by the Chat dialog callback. User Properties are intentionally
  // used instead of the spreadsheet so optional sharing never pushes a successful
  // ticket import over Chat's callback time limit.
  function queueSharingIntent(ticketId, ctx, options) {
    options = options || {};
    const announce = bool_(options.announce_created);
    const notifyComplete = bool_(options.notify_on_complete);
    if (!announce && !notifyComplete) return { queued: false };
    const row = {
      queue_id: Utilities.getUuid(),
      ticket_id: String(ticketId || ''),
      space_name: String(ctx && ctx.space_name || ''),
      space_type: String(ctx && ctx.space_type || ''),
      space_display_name: String(ctx && ctx.space_display_name || ''),
      thread_name: String(options.thread_name || ''),
      originator_email: String(ctx && ctx.invoking_email || currentUserEmail_() || '').toLowerCase(),
      participant_json: JSON.stringify(ctx && ctx.participants || []),
      announce_created: announce,
      created_include_view_link: bool_(options.created_include_view_link),
      notify_on_complete: notifyComplete,
      complete_include_view_link: bool_(options.complete_include_view_link),
      queued_at: Repo.now()
    };
    if (!row.ticket_id || !row.space_name) return { queued: false };
    let rows = pendingSharingRows_().filter(function (x) {
      return !(String(x.ticket_id) === row.ticket_id && String(x.space_name) === row.space_name && String(x.thread_name || '') === row.thread_name);
    });
    rows.unshift(row);
    savePendingSharingRows_(rows);
    return { queued: true, queue_id: row.queue_id };
  }

  function materializePendingSharingIntents_() {
    requireWriter_();
    const rows = pendingSharingRows_();
    if (!rows.length) return { checked: 0, saved: 0, errors: [] };
    const remaining = [];
    const errors = [];
    let saved = 0;
    rows.forEach(function (row) {
      try {
        let participants = [];
        try { participants = JSON.parse(String(row.participant_json || '[]')); } catch (ignore) {}
        upsertChatLink(row.ticket_id, {
          space_name: row.space_name,
          space_type: row.space_type,
          space_display_name: row.space_display_name,
          invoking_email: row.originator_email,
          participants: participants
        }, {
          thread_name: row.thread_name,
          notify_on_complete: bool_(row.notify_on_complete),
          complete_include_view_link: bool_(row.complete_include_view_link),
          created_include_view_link: bool_(row.created_include_view_link),
          created_posted: !bool_(row.announce_created),
          defer_trigger_check: true
        });
        saved++;
      } catch (e) {
        remaining.push(row);
        errors.push({ ticket_id: row.ticket_id, space_name: row.space_name, message: e.message });
      }
    });
    savePendingSharingRows_(remaining);
    return { checked: rows.length, saved: saved, errors: errors };
  }

  function upsertChatLink(ticketId, ctx, options) {
    requireWriter_();
    options = options || {};
    const threadName = String(options.thread_name || '');
    const rows = Repo.findAll(TABS.CHAT_LINKS, 'ticket_id', ticketId);
    const existing = rows.filter(function (r) {
      return String(r.space_name) === String(ctx.space_name) && String(r.thread_name || '') === threadName;
    })[0] || null;
    const now = Repo.now();
    const patch = {
      ticket_id: ticketId,
      space_name: ctx.space_name,
      space_type: ctx.space_type,
      space_display_name: ctx.space_display_name,
      thread_name: threadName,
      originator_email: existing ? (existing.originator_email || ctx.invoking_email) : ctx.invoking_email,
      participant_json: JSON.stringify(ctx.participants || []),
      // Re-importing more messages from the same Chat must not silently turn off
      // sharing/completion settings chosen on an earlier import. A future explicit
      // settings UI can support disabling these; this intake flow only enables them.
      notify_on_complete: existing ? (bool_(existing.notify_on_complete) || bool_(options.notify_on_complete)) : bool_(options.notify_on_complete),
      complete_include_view_link: existing ? (bool_(existing.complete_include_view_link) || bool_(options.complete_include_view_link)) : bool_(options.complete_include_view_link),
      created_include_view_link: existing ? (bool_(existing.created_include_view_link) || bool_(options.created_include_view_link)) : bool_(options.created_include_view_link),
      created_posted: existing ? (bool_(existing.created_posted) || bool_(options.created_posted)) : bool_(options.created_posted),
      created_by: existing ? existing.created_by : Repo.me(),
      created_at: existing ? existing.created_at : now,
      updated_at: now,
      completion_notified_at: existing ? existing.completion_notified_at : ''
    };
    let saved;
    if (existing) saved = Repo.update(TABS.CHAT_LINKS, 'chat_link_id', existing.chat_link_id, patch);
    else {
      patch.chat_link_id = Utilities.getUuid();
      saved = Repo.append(TABS.CHAT_LINKS, patch);
    }
    if (!bool_(options.defer_trigger_check) && bool_(saved.notify_on_complete) && String(saved.originator_email || '').toLowerCase() === currentUserEmail_()) {
      try {
        ensureMyCompletionTrigger_();
      } catch (e) {
        saved._trigger_warning = e.message;
        Logger.log('Chat completion trigger scheduling warning: %s', e.message);
      }
    }
    return saved;
  }

  function listLinks(ticketId) {
    Repo.requireAccess('agent');
    return Repo.findAll(TABS.CHAT_LINKS, 'ticket_id', ticketId);
  }

  function dashboardBaseUrl_() {
    const configured = String(PropertiesService.getScriptProperties().getProperty('PROJECT_TRACKER_WEB_APP_URL') || '').trim();
    if (configured) return configured.split('?')[0];
    const runtime = String(ScriptApp.getService().getUrl() || '').trim().split('?')[0];
    if (!runtime) throw new Error('Set Script Property PROJECT_TRACKER_WEB_APP_URL to the existing Project Tracker dashboard /exec URL.');
    Logger.log('PROJECT_TRACKER_WEB_APP_URL is not configured; using the current deployment URL as a fallback.');
    return runtime;
  }

  function internalTicketUrl_(ticketId) {
    return dashboardBaseUrl_() + '?ticket=' + encodeURIComponent(String(ticketId || ''));
  }

  function shareUrl_(ticketId) {
    const payload = Tickets.viewerSharePayload(ticketId);
    const base = dashboardBaseUrl_();
    return base + '?ticket=' + encodeURIComponent(payload.ticketId) + '&share=' + encodeURIComponent(payload.shareToken);
  }

  function ownersLabel_(ticket) {
    const byEmail = {};
    Repo.activeAgents().forEach(function (a) { byEmail[String(a.email || '').toLowerCase()] = a.display_name || a.email; });
    const names = String(ticket.owners || '').split(',').map(function (e) {
      const key = String(e || '').toLowerCase().trim();
      return byEmail[key] || key.split('@')[0];
    }).filter(Boolean);
    if (!names.length) return 'Unassigned';
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  function creationMessage(ticket, includeLink) {
    let text = 'Your request has been logged as a project: *' + String(ticket.title || ticket.ticket_id) + '*\n' +
      'Assigned to ' + ownersLabel_(ticket) + '.';
    if (includeLink) text += '\n' + shareUrl_(ticket.ticket_id);
    return text;
  }

  function completionMessage(ticket, includeLink) {
    let text = 'Your request is finished: *' + String(ticket.title || ticket.ticket_id) + '*';
    if (includeLink) text += '\n' + shareUrl_(ticket.ticket_id);
    return text;
  }

  function serviceAccount_() {
    const props = PropertiesService.getScriptProperties();
    const raw = String(props.getProperty('CHAT_SERVICE_ACCOUNT_JSON') || '').trim();
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        if (obj.client_email && obj.private_key) return obj;
      } catch (e) { throw new Error('CHAT_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
    }
    const email = String(props.getProperty('CHAT_SERVICE_ACCOUNT_EMAIL') || '').trim();
    const key = String(props.getProperty('CHAT_SERVICE_ACCOUNT_PRIVATE_KEY') || '').replace(/\\n/g, '\n').trim();
    return email && key ? { client_email: email, private_key: key } : null;
  }

  function webSafeBase64_(value) {
    const bytes = typeof value === 'string' ? Utilities.newBlob(value).getBytes() : value;
    return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
  }

  function serviceAccountToken_() {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(SA_CACHE_KEY);
    if (cached) return cached;
    const sa = serviceAccount_();
    if (!sa) throw new Error('Project Tracker Chat service account is not configured.');
    const now = Math.floor(Date.now() / 1000);
    const header = webSafeBase64_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = webSafeBase64_(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/chat.bot',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    }));
    const unsigned = header + '.' + claim;
    const signature = Utilities.computeRsaSha256Signature(unsigned, sa.private_key);
    const assertion = unsigned + '.' + webSafeBase64_(signature);
    const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: assertion
      },
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code < 200 || code >= 300) throw new Error('Chat service-account authorization failed (' + code + ').');
    const json = JSON.parse(body);
    if (!json.access_token) throw new Error('Chat service-account token was not returned.');
    cache.put(SA_CACHE_KEY, json.access_token, Number(CONFIG.CHAT_SERVICE_ACCOUNT_CACHE_SECONDS) || 3000);
    return json.access_token;
  }

  function chatFetch_(method, path, body, token) {
    const opts = {
      method: method,
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    };
    if (body !== undefined && body !== null) {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(body);
    }
    const response = UrlFetchApp.fetch('https://chat.googleapis.com/v1/' + String(path || '').replace(/^\//, ''), opts);
    const code = response.getResponseCode();
    const text = response.getContentText();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch (ignore) {}
    if (code < 200 || code >= 300) {
      const msg = parsed && parsed.error && parsed.error.message ? parsed.error.message : ('HTTP ' + code);
      throw new Error(msg);
    }
    return parsed;
  }

  function sendAsApp_(spaceName, text) {
    const token = serviceAccountToken_();
    return chatFetch_('post', String(spaceName).replace(/^\//, '') + '/messages', { text: String(text || '') }, token);
  }

  function sendAsUser_(spaceName, text) {
    return chatFetch_('post', String(spaceName).replace(/^\//, '') + '/messages', { text: String(text || '') }, ScriptApp.getOAuthToken());
  }

  function currentUserEmail_() {
    const active = String(Repo.me() || '').toLowerCase().trim();
    if (active) return active;
    return String(Session.getEffectiveUser().getEmail() || '').toLowerCase().trim();
  }

  function myCompletionLinks_() {
    const me = currentUserEmail_();
    if (!me) return [];
    return Repo.readAll(TABS.CHAT_LINKS).filter(function (row) {
      return String(row.originator_email || '').toLowerCase() === me && bool_(row.notify_on_complete);
    });
  }

  function ensureMyCompletionTrigger_() {
    if (typeof ensureProjectTrackerHourlyTrigger_ === 'function') {
      return ensureProjectTrackerHourlyTrigger_();
    }
    // Compatibility fallback if only this file has been updated. Normally the
    // unified hourly trigger is provided by GmailTicketing.gs.
    const exists = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === ORIGIN_TRIGGER_HANDLER;
    });
    if (!exists) {
      ScriptApp.getProjectTriggers().forEach(function (t) {
        if (t.getHandlerFunction() === LEGACY_ORIGIN_TRIGGER_HANDLER) ScriptApp.deleteTrigger(t);
      });
      ScriptApp.newTrigger(ORIGIN_TRIGGER_HANDLER)
        .timeBased()
        .everyHours(Math.max(1, Number(CONFIG.CHAT_COMPLETION_POLL_HOURS) || 1))
        .create();
    }
    return { ok: true, installed: true, handler: ORIGIN_TRIGGER_HANDLER, user: currentUserEmail_() };
  }

  function queuedCreationLinks_() {
    const me = currentUserEmail_();
    if (!me) return [];
    return Repo.readAll(TABS.CHAT_LINKS).filter(function (row) {
      return String(row.originator_email || '').toLowerCase() === me && !bool_(row.created_posted);
    });
  }

  function processMyCreationAnnouncements_() {
    requireWriter_();
    const queued = materializePendingSharingIntents_();
    const links = queuedCreationLinks_();
    if (!links.length) return { checked: 0, sent: 0, materialized: queued.saved || 0, errors: queued.errors || [] };
    const ticketMap = {};
    Repo.readAll(TABS.TICKETS).forEach(function (ticket) { ticketMap[String(ticket.ticket_id)] = ticket; });
    let sent = 0;
    const errors = [];
    links.forEach(function (row) {
      const ticket = ticketMap[String(row.ticket_id)] || null;
      if (!ticket) {
        errors.push({ chat_link_id: row.chat_link_id, ticket_id: row.ticket_id, message: 'Project not found.' });
        return;
      }
      try {
        let participants = [];
        try { participants = JSON.parse(String(row.participant_json || '[]')); } catch (ignore) {}
        const grantEmails = participants.filter(function (p) { return p && p.grant_viewer && p.email; }).map(function (p) { return p.email; });
        if ((bool_(row.created_include_view_link) || bool_(row.complete_include_view_link)) && grantEmails.length) {
          ensureViewerAccess(grantEmails, participants);
        }
        sendAsUser_(row.space_name, creationMessage(ticket, bool_(row.created_include_view_link)));
        Repo.update(TABS.CHAT_LINKS, 'chat_link_id', row.chat_link_id, { created_posted: true, updated_at: Repo.now() });
        sent++;
      } catch (e) {
        errors.push({ chat_link_id: row.chat_link_id, ticket_id: row.ticket_id, space_name: row.space_name, message: e.message });
      }
    });
    return { checked: links.length, sent: sent, materialized: queued.saved || 0, errors: (queued.errors || []).concat(errors) };
  }

  function processMyCompletionNotifications_() {
    const user = Repo.requireAccess('agent');
    const queued = materializePendingSharingIntents_();
    const me = String(user.email || currentUserEmail_()).toLowerCase();
    const links = myCompletionLinks_();
    const ticketMap = {};
    Repo.readAll(TABS.TICKETS).forEach(function (ticket) { ticketMap[String(ticket.ticket_id)] = ticket; });
    let sent = 0, checked = 0;
    const errors = [];

    links.forEach(function (row) {
      checked++;
      const ticket = ticketMap[String(row.ticket_id)] || null;
      if (!ticket || String(ticket.status) !== String(STATUS.COMPLETED) || !ticket.completed_at) return;
      if (String(row.completion_notified_at || '') === String(ticket.completed_at)) return;
      try {
        sendAsUser_(row.space_name, completionMessage(ticket, bool_(row.complete_include_view_link)));
        Repo.update(TABS.CHAT_LINKS, 'chat_link_id', row.chat_link_id, {
          completion_notified_at: ticket.completed_at,
          updated_at: Repo.now()
        });
        sent++;
      } catch (e) {
        errors.push({ chat_link_id: row.chat_link_id, ticket_id: row.ticket_id, space_name: row.space_name, message: e.message });
      }
    });

    return { user: me, checked: checked, sent: sent, materialized: queued.saved || 0, errors: (queued.errors || []).concat(errors) };
  }

  const WATCHER_CHAT_USER_PREFIX = 'pt_chat_watcher_user_';

  function watcherUserKey_(email) {
    email = String(email || '').toLowerCase().trim();
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email, Utilities.Charset.UTF_8);
    return WATCHER_CHAT_USER_PREFIX + Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '');
  }

  function resolveCurrentWatcherUserName_(email) {
    email = String(email || '').toLowerCase().trim();
    if (!email) throw new Error('Missing Google Chat user email.');

    const props = PropertiesService.getScriptProperties();
    const key = watcherUserKey_(email);
    const saved = String(props.getProperty(key) || '').trim();
    if (/^users\/[^/]+$/.test(saved)) return saved;

    // This runs while the watcher is saving their own settings in the web app,
    // so a normal user-authorized People API call can resolve the stable person ID.
    const me = String(currentUserEmail_() || '').toLowerCase().trim();
    if (me !== email) {
      throw new Error('Project Tracker has not learned this watcher\'s Google Chat user ID yet. The watcher must save Google Chat completion pings once from their own account.');
    }

    const person = peopleFetch_('people/me?personFields=names%2CemailAddresses');
    const resourceName = String(person && person.resourceName || '');
    const match = resourceName.match(/^people\/(.+)$/);
    if (!match) throw new Error('Google People did not return a stable user ID for ' + email + '.');

    const userName = 'users/' + match[1];
    props.setProperty(key, userName);
    return userName;
  }

  function cachedWatcherUserName_(email) {
    email = String(email || '').toLowerCase().trim();
    if (!email) throw new Error('Missing Google Chat user email.');
    const saved = String(PropertiesService.getScriptProperties().getProperty(watcherUserKey_(email)) || '').trim();
    if (!/^users\/[^/]+$/.test(saved)) {
      throw new Error('Project Tracker has not stored a Google Chat user ID for ' + email + '. Open the Project Tracker Chat DM, then save the Google Chat completion-ping watch from that user\'s own account once.');
    }
    return saved;
  }

  function watcherDmSpaceByUserName_(userName) {
    const token = serviceAccountToken_();
    return chatFetch_('get', 'spaces:findDirectMessage?name=' + encodeURIComponent(userName), null, token);
  }

  function watcherDmSpace_(email) {
    return watcherDmSpaceByUserName_(cachedWatcherUserName_(email));
  }

  function notifyWatcher_(email, ticket) {
    const space = watcherDmSpace_(email);
    if (!space || !space.name) throw new Error('No Project Tracker Chat DM exists for ' + email + '. Open a direct message with the Project Tracker Chat app once, then try again.');
    const text = 'Project completed: *' + String(ticket.title || ticket.ticket_id) + '*\n' + internalTicketUrl_(ticket.ticket_id);
    return sendAsApp_(space.name, text);
  }

  function assertWatcherDmAvailable_(email) {
    try {
      const userName = resolveCurrentWatcherUserName_(email);
      const space = watcherDmSpaceByUserName_(userName);
      if (!space || !space.name) throw new Error('No DM found.');
      return { ok: true, space_name: space.name, user_name: userName };
    } catch (e) {
      throw new Error('Google Chat completion pings are not ready for ' + String(email || '') + '. Open a direct message with the Project Tracker Chat app once, then save the watch again. (' + e.message + ')');
    }
  }

  function notifyTicketCompleted(ticket, actorEmail) {
    if (!ticket || !ticket.ticket_id || !ticket.completed_at) return { originQueued: 0, watchers: 0, errors: [] };
    const errors = [];
    let watcherCount = 0;

    let links = [];
    try { links = Repo.findAll(TABS.CHAT_LINKS, 'ticket_id', ticket.ticket_id); }
    catch (e) { Logger.log('ChatLinks unavailable: %s', e.message); }
    const originQueued = links.filter(function (row) {
      return bool_(row.notify_on_complete) && String(row.completion_notified_at || '') !== String(ticket.completed_at);
    }).length;

    const allowed = {};
    Repo.activeAgents().forEach(function (a) {
      const role = String(a.role || '').toLowerCase();
      if (role === 'agent' || role === 'editor') allowed[String(a.email || '').toLowerCase()] = true;
    });
    Repo.findAll(TABS.WATCHES, 'ticket_id', ticket.ticket_id).forEach(function (w) {
      const email = String(w.user_email || '').toLowerCase();
      if (!bool_(w.chat_on_complete) || !allowed[email]) return;
      if (String(w.chat_completion_notified_at || '') === String(ticket.completed_at)) return;
      try {
        notifyWatcher_(email, ticket);
        Repo.update(TABS.WATCHES, 'watch_id', w.watch_id, {
          chat_completion_notified_at: ticket.completed_at,
          updated_at: Repo.now()
        });
        watcherCount++;
      } catch (e) { errors.push({ target: email, message: e.message }); }
    });

    // Origin-conversation completion notices are intentionally not sent from
    // this shared backend execution. Each originator owns an hourly trigger
    // that runs with that user's authorization and posts only to Chats they can access.
    return { originQueued: originQueued, watchers: watcherCount, errors: errors };
  }

  function postCreationAnnouncement(ticket, ctx, includeLink) {
    return sendAsUser_(ctx.space_name, creationMessage(ticket, includeLink));
  }

  function mergeTickets(primaryId, secondaryId) {
    requireWriter_();
    let secondary = [];
    try { secondary = Repo.findAll(TABS.CHAT_LINKS, 'ticket_id', secondaryId); }
    catch (e) { return { moved: 0, combined: 0 }; }
    const primary = Repo.findAll(TABS.CHAT_LINKS, 'ticket_id', primaryId);
    let moved = 0, combined = 0;
    secondary.forEach(function (row) {
      const match = primary.filter(function (p) {
        return String(p.space_name) === String(row.space_name) && String(p.thread_name || '') === String(row.thread_name || '');
      })[0] || null;
      if (match) {
        Repo.update(TABS.CHAT_LINKS, 'chat_link_id', match.chat_link_id, {
          notify_on_complete: bool_(match.notify_on_complete) || bool_(row.notify_on_complete),
          complete_include_view_link: bool_(match.complete_include_view_link) || bool_(row.complete_include_view_link),
          created_include_view_link: bool_(match.created_include_view_link) || bool_(row.created_include_view_link),
          created_posted: bool_(match.created_posted) || bool_(row.created_posted),
          participant_json: match.participant_json || row.participant_json || '[]',
          updated_at: Repo.now()
        });
        Repo.remove(TABS.CHAT_LINKS, 'chat_link_id', row.chat_link_id);
        combined++;
      } else {
        Repo.update(TABS.CHAT_LINKS, 'chat_link_id', row.chat_link_id, { ticket_id: primaryId, updated_at: Repo.now() });
        primary.push(Object.assign({}, row, { ticket_id: primaryId }));
        moved++;
      }
    });
    return { moved: moved, combined: combined };
  }

  function verifyConfiguration() {
    const props = PropertiesService.getScriptProperties();
    const me = currentUserEmail_();
    const triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    const out = {
      chatServiceAvailable: typeof Chat !== 'undefined',
      chatSourcePickerAvailable: false,
      peopleApiConfigured: false,
      serviceAccountConfigured: !!serviceAccount_(),
      spreadsheetConfigured: !!props.getProperty('SPREADSHEET_ID'),
      dashboardUrlConfigured: !!String(props.getProperty('PROJECT_TRACKER_WEB_APP_URL') || '').trim(),
      chatLinksReady: false,
      currentUser: me,
      userCompletionTriggerInstalled: triggers.indexOf(ORIGIN_TRIGGER_HANDLER) >= 0 || triggers.indexOf(LEGACY_ORIGIN_TRIGGER_HANDLER) >= 0,
      userCompletionLinks: 0
    };
    try {
      peopleFetch_('people/me?personFields=names%2CemailAddresses');
      out.peopleApiConfigured = true;
    } catch (e) {
      out.peopleApiError = e.message;
    }
    try {
      const testSpaces = Chat.Spaces.list({ pageSize: 1, filter: 'spaceType = "DIRECT_MESSAGE" OR spaceType = "GROUP_CHAT"' });
      out.chatSourcePickerAvailable = true;
    } catch (e) {
      out.chatSourcePickerError = e.message;
    }
    try {
      Repo.readAll(TABS.CHAT_LINKS);
      out.chatLinksReady = true;
      out.userCompletionLinks = myCompletionLinks_().length;
    } catch (e) { out.chatLinksError = e.message; }
    if (out.serviceAccountConfigured) {
      try { serviceAccountToken_(); out.serviceAccountAuth = true; }
      catch (e) { out.serviceAccountAuth = false; out.serviceAccountError = e.message; }
    }
    return out;
  }

  return {
    buildContext: buildContext,
    buildContextForSpace: buildContextForSpace,
    buildContextFromMessageLink: buildContextFromMessageLink,
    buildContextForDirectMessage: buildContextForDirectMessage,
    searchDirectoryPeople: searchDirectoryPeople,
    recentSources: recentSources,
    discoverRecentDirectSources: discoverRecentDirectSources,
    listSourceConversations: listSourceConversations,
    getContext: getContext,
    reserveCreateTicketId: reserveCreateTicketId,
    createTicketWithMessagesFast: createTicketWithMessagesFast,
    deleteContext: deleteContext_,
    importMessages: importMessages,
    queueSharingIntent: queueSharingIntent,
    processPendingSharingIntents: materializePendingSharingIntents_,
    processPendingImports: processPendingImports,
    processPendingImportsForTicket: processPendingImportsForTicket,
    processMyCreationAnnouncements: processMyCreationAnnouncements_,
    missingViewerEmails: missingViewerEmails,
    ensureViewerAccess: ensureViewerAccess,
    upsertChatLink: upsertChatLink,
    listLinks: listLinks,
    mergeTickets: mergeTickets,
    postCreationAnnouncement: postCreationAnnouncement,
    notifyTicketCompleted: notifyTicketCompleted,
    ensureMyCompletionTrigger: ensureMyCompletionTrigger_,
    processMyCompletionNotifications: processMyCompletionNotifications_,
    assertWatcherDmAvailable: assertWatcherDmAvailable_,
    creationMessage: creationMessage,
    completionMessage: completionMessage,
    verifyConfiguration: verifyConfiguration
  };
})();

function processProjectTrackerChatCompletions() {
  return ChatTicketing.processMyCompletionNotifications();
}

function installMyProjectTrackerChatCompletionTrigger() {
  Repo.requireAccess('agent');
  return ChatTicketing.ensureMyCompletionTrigger();
}

function repairMyProjectTrackerChatCompletionTrigger() {
  Repo.requireAccess('agent');
  if (typeof repairProjectTrackerHourlyTrigger === 'function') return repairProjectTrackerHourlyTrigger();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processProjectTrackerChatCompletions' || t.getHandlerFunction() === 'processProjectTrackerHourlyJobs') ScriptApp.deleteTrigger(t);
  });
  return ChatTicketing.ensureMyCompletionTrigger();
}


function processPendingChatImports() {
  Repo.requireAccess('agent');
  const out = ChatTicketing.processPendingImports(50);
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function verifyGoogleChatIntegration() {
  Repo.requireAccess('agent');
  const out = ChatTicketing.verifyConfiguration();
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
