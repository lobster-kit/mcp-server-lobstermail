import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getClient, getInbox, cacheInbox } from './state.js';

const server = new McpServer(
  { name: '@lobsterkit/lobstermail-mcp', version: '1.5.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'LobsterMail gives you email. Create inboxes, receive emails, wait for verification codes — no human needed. ' +
      'Start with create_inbox to get an @lobstermail.ai address, then use wait_for_email or check_inbox to read messages.',
  },
);

// ── create_inbox ──────────────────────────────────────────────────────────────

server.registerTool('create_inbox', {
  title: 'Create Email Inbox',
  description:
    'Create a new email inbox. Returns an @lobstermail.ai address. ' +
    'Provide your name/org for a meaningful address (e.g. sarah-shield@lobstermail.ai), ' +
    'or omit for a random lobster-xxxx address.',
  inputSchema: {
    name: z.string().optional().describe('Your name or agent name (e.g. "Sarah Shield")'),
    org: z.string().optional().describe('Organization name (e.g. "Palisade")'),
    preferred: z
      .array(z.string())
      .optional()
      .describe('Explicit local parts to try first (e.g. ["billing-bot", "billing"])'),
    displayName: z.string().optional().describe('Display name for the inbox'),
  },
}, async ({ name, org, preferred, displayName }) => {
  const lm = await getClient();
  const hasSmartOpts = name || org || preferred;
  const inbox = hasSmartOpts
    ? await lm.createSmartInbox({ name, org, preferred, displayName })
    : await lm.createInbox({ displayName });
  cacheInbox(inbox);

  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Inbox created successfully.`,
          ``,
          `Address: ${inbox.address}`,
          `Inbox ID: ${inbox.id}`,
          `Active: ${inbox.isActive}`,
          inbox.expiresAt ? `Expires: ${inbox.expiresAt}` : null,
          ``,
          `Use this inbox_id with check_inbox, wait_for_email, and other tools.`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
});

// ── check_inbox ───────────────────────────────────────────────────────────────

server.registerTool('check_inbox', {
  title: 'Check Inbox',
  description: 'List recent emails in an inbox. Returns sender, subject, and preview for each email.',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID (e.g. ibx_...)'),
    limit: z.number().optional().describe('Max emails to return (default: 20)'),
    since: z.string().optional().describe('Only emails after this ISO 8601 timestamp'),
  },
}, async ({ inbox_id, limit, since }) => {
  const inbox = await getInbox(inbox_id);
  const { data: emails } = await inbox.receive({ limit, since });

  if (emails.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No emails found in this inbox.' }] };
  }

  const lines = emails.map(
    (e: any) =>
      `- [${e.id}] From: ${e.from} | Subject: ${e.subject} | ${e.createdAt}` +
      (e.isInjectionRisk ? ' ⚠️ INJECTION RISK' : ''),
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: `${emails.length} email(s) found:\n\n${lines.join('\n')}\n\nUse get_email with an email_id to read the full body.`,
      },
    ],
  };
});

// ── wait_for_email ────────────────────────────────────────────────────────────

server.registerTool('wait_for_email', {
  title: 'Wait for Email',
  description:
    'Wait for an incoming email matching optional filters. ' +
    'Returns near-instantly when an email arrives (real-time server-side long-polling). ' +
    'Returns the email body in LLM-safe format.',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID (e.g. ibx_...)'),
    from: z.string().optional().describe('Filter by sender address'),
    subject: z.string().optional().describe('Filter by subject (substring match)'),
    timeout: z
      .number()
      .optional()
      .describe('Max wait time in milliseconds (default: 60000, max: 120000)'),
  },
}, async ({ inbox_id, from, subject, timeout }) => {
  const inbox = await getInbox(inbox_id);
  const effectiveTimeout = Math.min(timeout ?? 60_000, 120_000);

  const email = await inbox.waitForEmail({
    filter: { from, subject },
    timeout: effectiveTimeout,
  });

  if (!email) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No matching email received within ${effectiveTimeout / 1000}s. Try again with a longer timeout or check the inbox address.`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Email received!`,
          ``,
          `Email ID: ${email.id}`,
          `From: ${email.from}`,
          `Subject: ${email.subject}`,
          email.isInjectionRisk ? `⚠️ INJECTION RISK DETECTED` : '',
          ``,
          email.safeBodyForLLM(),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
});

// ── get_email ─────────────────────────────────────────────────────────────────

server.registerTool('get_email', {
  title: 'Get Email',
  description: 'Get a single email by ID with full body in LLM-safe format.',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID (e.g. ibx_...)'),
    email_id: z.string().describe('Email ID (e.g. eml_...)'),
  },
}, async ({ inbox_id, email_id }) => {
  const inbox = await getInbox(inbox_id);
  const email = await inbox.getEmail(email_id);

  const parts: string[] = [
    `Email ID: ${email.id}`,
    `From: ${email.from}`,
    `To: ${email.to.join(', ')}`,
    `Subject: ${email.subject}`,
    `Date: ${email.createdAt}`,
    email.isInjectionRisk ? `⚠️ INJECTION RISK (score: ${email.security.injectionRiskScore})` : '',
    ``,
    email.safeBodyForLLM(),
  ];

  if (email.attachments && email.attachments.length > 0) {
    parts.push('', 'Attachments:');
    for (const att of email.attachments) {
      parts.push(`- ${att.filename} (${att.contentType}, ${att.sizeBytes} bytes)`);
    }
  }

  return { content: [{ type: 'text' as const, text: parts.filter(Boolean).join('\n') }] };
});

// ── send_email ────────────────────────────────────────────────────────────────

server.registerTool('send_email', {
  title: 'Send Email',
  description:
    'Send an email from an inbox. Requires a verified account (Tier 1+). ' +
    'To reply within a thread, provide in_reply_to with the Message-ID of the email being replied to.',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID to send from'),
    to: z.array(z.string()).describe('Recipient email addresses'),
    subject: z.string().describe('Email subject'),
    body_text: z.string().describe('Plain text email body'),
    body_html: z.string().optional().describe('HTML email body (optional)'),
    cc: z.array(z.string()).optional().describe('CC recipients'),
    in_reply_to: z.string().optional().describe('Message-ID of the email being replied to (enables threading)'),
  },
}, async ({ inbox_id, to, subject, body_text, body_html, cc, in_reply_to }) => {
  const inbox = await getInbox(inbox_id);
  const result = await inbox.send({
    to,
    cc,
    subject,
    body: { text: body_text, html: body_html },
    inReplyTo: in_reply_to,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Email queued for delivery.\n\nEmail ID: ${result.id}\nStatus: ${result.status}`,
      },
    ],
  };
});

// ── search_emails ────────────────────────────────────────────────────────────

server.registerTool('search_emails', {
  title: 'Search Emails',
  description:
    'Search emails across all inboxes by keyword. ' +
    'Matches against subject, sender address, and body preview. ' +
    'Optionally scope to a single inbox or filter by sender, direction, date, or attachments.',
  inputSchema: {
    query: z.string().describe('Search query (e.g. "invoice", "verification code")'),
    inbox_id: z.string().optional().describe('Scope search to a specific inbox ID'),
    from: z.string().optional().describe('Filter by sender address (partial match)'),
    direction: z.enum(['inbound', 'outbound']).optional().describe('Filter by email direction'),
    since: z.string().optional().describe('Only emails after this ISO 8601 date'),
    until: z.string().optional().describe('Only emails before this ISO 8601 date'),
    has_attachments: z.boolean().optional().describe('Filter by attachment presence'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (1-50, default 20)'),
  },
}, async ({ query, inbox_id, from, direction, since, until, has_attachments, limit }) => {
  const lm = await getClient();
  const results = await lm.searchEmails({
    q: query,
    inboxId: inbox_id,
    from,
    direction,
    since,
    until,
    hasAttachments: has_attachments,
    limit,
  });

  if (results.data.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No emails found matching "${query}".` }],
    };
  }

  const lines = results.data.map(
    (e) =>
      `- [${e.id}] Inbox: ${e.inboxId} | From: ${e.from} | Subject: ${e.subject} | ${e.createdAt}` +
      (e.isInjectionRisk ? ' ⚠️ INJECTION RISK' : ''),
  );

  const footer = results.hasMore
    ? `\n\nMore results available. Use get_email with an email_id and inbox_id to read the full body.`
    : `\n\nUse get_email with an email_id and inbox_id to read the full body.`;

  return {
    content: [
      {
        type: 'text' as const,
        text: `${results.data.length} email(s) found for "${query}":\n\n${lines.join('\n')}${footer}`,
      },
    ],
  };
});

// ── list_threads ─────────────────────────────────────────────────────────────

server.registerTool('list_threads', {
  title: 'List Threads',
  description:
    'List conversation threads for an inbox. ' +
    'Threads group related emails by In-Reply-To/References headers or subject matching. ' +
    'Returns newest threads first.',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID (e.g. ibx_...)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max threads to return (default: 20, max: 50)'),
    cursor: z.string().optional().describe('Pagination cursor from previous response'),
  },
}, async ({ inbox_id, limit, cursor }) => {
  const inbox = await getInbox(inbox_id);
  const result = await inbox.listThreads({ limit, cursor });

  if (result.data.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No threads found in this inbox.' }] };
  }

  const lines = result.data.map(
    (t: any) => `- [${t.id}] ${t.subject} (${t.emailCount} emails, last: ${t.lastEmailAt})`,
  );

  const footer = result.hasMore
    ? `\n\nMore threads available. Pass cursor "${result.cursor}" for next page.`
    : '';

  return {
    content: [
      {
        type: 'text' as const,
        text: `${result.data.length} thread(s) found:\n\n${lines.join('\n')}${footer}\n\nUse get_thread with a thread_id to see all emails in a conversation.`,
      },
    ],
  };
});

// ── get_thread ───────────────────────────────────────────────────────────────

server.registerTool('get_thread', {
  title: 'Get Thread',
  description:
    'Get a conversation thread with all its emails in chronological order. ' +
    'Shows the full conversation flow including sender, subject, and preview for each email.',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID (e.g. ibx_...)'),
    thread_id: z.string().describe('Thread ID (e.g. thd_...)'),
  },
}, async ({ inbox_id, thread_id }) => {
  const inbox = await getInbox(inbox_id);
  const thread = await inbox.getThread(thread_id);

  const emailLines = thread.emails.map(
    (e: any, i: number) =>
      `${i + 1}. [${e.id}] From: ${e.from} | Subject: ${e.subject} | ${e.createdAt}` +
      (e.preview ? `\n   Preview: ${e.preview.slice(0, 100)}...` : ''),
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Thread: ${thread.subject}`,
          `Thread ID: ${thread.id}`,
          `Emails: ${thread.emailCount}`,
          `Last activity: ${thread.lastEmailAt}`,
          ``,
          `Conversation:`,
          ...emailLines,
          ``,
          `Use get_email with an email_id and inbox_id to read the full body of any email.`,
        ].join('\n'),
      },
    ],
  };
});

// ── extract_email_data ────────────────────────────────────────────────────────

server.registerTool('extract_email_data', {
  title: 'Extract Email Data',
  description:
    'Extract structured data from an email using AI. ' +
    'Returns contacts, dates, amounts, scheduling data, and action items. ' +
    'Triggers extraction and waits for completion (up to 60s).',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID (e.g. ibx_...)'),
    email_id: z.string().describe('Email ID (e.g. eml_...)'),
    timeout: z
      .number()
      .optional()
      .describe('Max wait time in milliseconds (default: 60000)'),
  },
}, async ({ inbox_id, email_id, timeout }) => {
  const inbox = await getInbox(inbox_id);
  const email = await inbox.getEmail(email_id);
  const result = await email.waitForExtraction({ timeout: timeout ?? 60_000 });

  if (!result) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Extraction timed out. The extraction may still be processing — try extract_email_data again later.',
        },
      ],
    };
  }

  if (result.status === 'failed') {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Extraction failed: ${result.errorMessage ?? 'Unknown error'}`,
        },
      ],
    };
  }

  const sections: string[] = [
    `Extraction ID: ${result.id}`,
    `Status: ${result.status}`,
    `Model: ${result.modelUsed}`,
    `Processing time: ${result.processingMs}ms`,
    '',
  ];

  if (result.contacts.length > 0) {
    sections.push('**Contacts:**');
    for (const c of result.contacts) {
      const parts = [c.name, c.email, c.phone, c.role, c.organization].filter(Boolean);
      sections.push(`- ${parts.join(' | ')}`);
    }
    sections.push('');
  }

  if (result.dates.length > 0) {
    sections.push('**Dates:**');
    for (const d of result.dates) {
      sections.push(`- ${d.label}: ${d.value}${d.isEstimate ? ' (estimate)' : ''}`);
    }
    sections.push('');
  }

  if (result.amounts.length > 0) {
    sections.push('**Amounts:**');
    for (const a of result.amounts) {
      sections.push(`- ${a.label}: ${a.value} ${a.currency}`);
    }
    sections.push('');
  }

  if (result.scheduling.length > 0) {
    sections.push('**Scheduling:**');
    for (const s of result.scheduling) {
      const time = [s.startTime, s.endTime].filter(Boolean).join(' → ');
      sections.push(`- ${s.eventType}: ${s.summary}${time ? ` (${time})` : ''}${s.location ? ` @ ${s.location}` : ''}`);
    }
    sections.push('');
  }

  if (result.actions.length > 0) {
    sections.push('**Actions:**');
    for (const a of result.actions) {
      sections.push(`- [${a.type}] ${a.description}${a.url ? ` — ${a.url}` : ''}${a.deadline ? ` (by ${a.deadline})` : ''}`);
    }
    sections.push('');
  }

  if (result.metadata && Object.keys(result.metadata).length > 0) {
    sections.push('**Metadata:**');
    for (const [key, value] of Object.entries(result.metadata)) {
      sections.push(`- ${key}: ${JSON.stringify(value)}`);
    }
    sections.push('');
  }

  return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
});

// ── list_inboxes ──────────────────────────────────────────────────────────────

server.registerTool('list_inboxes', {
  title: 'List Inboxes',
  description: 'List all active inboxes for this account.',
  inputSchema: {},
}, async () => {
  const lm = await getClient();
  const inboxes = await lm.listInboxes();

  if (inboxes.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No inboxes found. Use create_inbox to create one.' }],
    };
  }

  for (const inbox of inboxes) {
    cacheInbox(inbox);
  }

  const lines = inboxes.map(
    (i) => `- [${i.id}] ${i.address} (${i.emailCount} emails, active: ${i.isActive})`,
  );

  return {
    content: [{ type: 'text' as const, text: `${inboxes.length} inbox(es):\n\n${lines.join('\n')}` }],
  };
});

// ── delete_inbox ──────────────────────────────────────────────────────────────

server.registerTool('delete_inbox', {
  title: 'Delete Inbox',
  description: 'Soft-delete an inbox. It enters a 7-day grace period before permanent deletion.',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID to delete'),
  },
}, async ({ inbox_id }) => {
  const lm = await getClient();
  await lm.deleteInbox(inbox_id);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Inbox ${inbox_id} has been soft-deleted. It will be permanently removed after 7 days.`,
      },
    ],
  };
});

// ── get_account ───────────────────────────────────────────────────────────────

server.registerTool('get_account', {
  title: 'Get Account Info',
  description: 'Get account information including tier, limits, and usage stats.',
  inputSchema: {},
}, async () => {
  const lm = await getClient();
  const acct = await lm.getAccount();

  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Account: ${acct.id}`,
          `Tier: ${acct.tier} (${acct.tierName})`,
          `Can send: ${acct.limits.canSend}`,
          `Max inboxes: ${acct.limits.maxInboxes ?? 'unlimited'}`,
          `Daily email limit: ${acct.limits.dailyEmailLimit}`,
          `Inboxes used: ${acct.usage.inboxCount}`,
          `Total emails received: ${acct.usage.totalEmailsReceived}`,
          `Created: ${acct.createdAt}`,
        ].join('\n'),
      },
    ],
  };
});

// ── Start server ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('LobsterMail MCP server failed to start:', err);
  process.exit(1);
});
