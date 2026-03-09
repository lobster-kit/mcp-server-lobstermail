import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getClient, getInbox, cacheInbox } from './state.js';

const server = new McpServer(
  { name: '@lobsterkit/lobstermail-mcp', version: '1.4.0' },
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
  const emails = await inbox.receive({ limit, since });

  if (emails.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No emails found in this inbox.' }] };
  }

  const lines = emails.map(
    (e) =>
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
  description: 'Send an email from an inbox. Requires a verified account (Tier 1+).',
  inputSchema: {
    inbox_id: z.string().describe('Inbox ID to send from'),
    to: z.array(z.string()).describe('Recipient email addresses'),
    subject: z.string().describe('Email subject'),
    body_text: z.string().describe('Plain text email body'),
    body_html: z.string().optional().describe('HTML email body (optional)'),
    cc: z.array(z.string()).optional().describe('CC recipients'),
  },
}, async ({ inbox_id, to, subject, body_text, body_html, cc }) => {
  const inbox = await getInbox(inbox_id);
  const result = await inbox.send({
    to,
    cc,
    subject,
    body: { text: body_text, html: body_html },
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
