import type { LedgerConfig } from '../lib/config.js';
import { getLedgerDir } from '../lib/config.js';
import { fetchCachedNotes } from '../lib/notes.js';
import { contentHash } from '../lib/hash.js';
import { ask, confirm, choose } from '../lib/prompt.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

// --- Communication Presets ---

const COMM_PRESETS: Record<string, string> = {
  'Direct': `- Concise by default, thorough only when the content demands it
- Structured outputs: headers, bullets, tables over prose
- No sycophancy: no "Great question!", no filler. Agreement means actual agreement.
- No emojis unless explicitly asked
- Scope control: do what was asked, don't gold-plate
- Don't narrate work while doing it. Do the thing, then report.
- Pushback welcome: disagree when something is wrong, bring reasoning`,

  'Educational': `- Explain concepts as you go, provide context for decisions
- Step-by-step walkthroughs for complex tasks
- Use analogies and plain language for unfamiliar topics
- Structured outputs with headers and bullets
- Be thorough — understanding matters more than speed
- No sycophancy: keep it honest and grounded`,

  'Collaborative': `- Ask before acting on anything non-trivial
- Present options with trade-offs, recommend but let user decide
- Discuss architecture and design before implementation
- Check in at milestones, don't go heads-down for too long
- Structured outputs with clear decision points
- No sycophancy: honest assessment over agreeableness`,
};

// --- Default Rules (always included) ---

const DEFAULT_SECURITY_RULES = `- Never read .env files or any files containing secrets/credentials
- Never read SSH keys, certificates (.pem, .key, .p12), AWS credentials, or auth tokens
- Check file existence with 'test -f' or 'wc -l', never by reading content
- Never expose API keys, tokens, or passwords in any output`;

const DEFAULT_KNOWLEDGE_RULES = `- Ledger is the source of truth for all knowledge
- Local files are cache — update Ledger first, then local
- Use ledger CLI for syncing between Ledger and local files`;

// --- Onboard ---

export async function onboard(config: LedgerConfig): Promise<void> {
  const envPath = resolve(getLedgerDir(), '.env');
  if (!existsSync(envPath)) {
    console.error('Ledger not initialized. Run `ledger init` first.');
    process.exit(1);
  }

  // Check if persona already exists
  const existing = await fetchCachedNotes(config.supabase);
  const hasProfile = existing.some(n => (n.metadata as Record<string, unknown>).type === 'user-preference');
  const hasFeedback = existing.some(n => (n.metadata as Record<string, unknown>).type === 'feedback');

  if (hasProfile || hasFeedback) {
    const proceed = await confirm('Persona notes already exist in Ledger. Run onboarding again? (will add, not replace)');
    if (!proceed) {
      console.error('Cancelled.');
      return;
    }
  }

  console.error('\nLet\'s set up your AI persona.\n');

  // 1. Name
  const name = await ask('What\'s your name? ');

  // 2. Role
  const role = await ask('What do you do? (e.g. Software Engineer, Student, Designer) ');

  // 3. Communication style
  const commStyle = await choose('How should the AI communicate with you?', [
    'Direct — concise, no filler, structured',
    'Educational — explain as you go, step by step',
    'Collaborative — ask before acting, discuss trade-offs',
    'Custom — define your own rules later',
  ]);

  // 4. Technical level
  const techLevel = await choose('Technical skill level?', [
    'Beginner — new to coding, explain everything',
    'Intermediate — comfortable coding, explain advanced concepts',
    'Senior — experienced, skip basics, focus on architecture',
  ]);

  // 5. Languages/frameworks
  const languages = await ask('Languages and frameworks you use? (comma-separated, or "skip") ');

  // 6. Learning goals (optional)
  const wantGoals = await confirm('Want to add learning goals?');
  let goals = '';
  if (wantGoals) {
    goals = await ask('What are you learning or working toward? ');
  }

  // --- Create notes ---

  console.error('\nCreating persona in Ledger...\n');

  // User profile
  const profileContent = [
    `## Role`,
    role,
    '',
    `## Technical Level`,
    techLevel.split(' — ')[0],
    '',
  ];

  if (languages && languages.toLowerCase() !== 'skip') {
    profileContent.push('## Technical Skills', languages, '');
  }

  if (goals) {
    profileContent.push('## Learning Goals', goals, '');
  }

  await createNote(config, {
    content: profileContent.join('\n'),
    type: 'user-preference',
    upsertKey: 'user-profile',
    localFile: 'user_profile.md',
    label: `${name}'s profile`,
  });

  // Communication style
  let commContent: string;
  if (commStyle.startsWith('Custom')) {
    commContent = '- Define your communication preferences here\n- Edit this note to customize';
  } else {
    const presetKey = commStyle.split(' — ')[0];
    commContent = COMM_PRESETS[presetKey] || COMM_PRESETS['Direct'];
  }

  await createNote(config, {
    content: commContent,
    type: 'feedback',
    upsertKey: 'feedback-communication-style',
    localFile: 'feedback_communication_style.md',
    label: 'communication style',
  });

  // Technical level as working style
  const levelDescriptions: Record<string, string> = {
    'Beginner': '- Explain all concepts in plain language with analogies\n- Step-by-step walkthroughs\n- Don\'t assume familiarity with tools or syntax',
    'Intermediate': '- Explain advanced concepts, skip basics\n- Provide context for architectural decisions\n- Assume familiarity with common tools and patterns',
    'Senior': '- Skip explanations unless asked\n- Focus on architecture, trade-offs, edge cases\n- Assume deep familiarity with tools and patterns',
  };

  const levelKey = techLevel.split(' — ')[0];
  await createNote(config, {
    content: levelDescriptions[levelKey] || levelDescriptions['Intermediate'],
    type: 'user-preference',
    upsertKey: 'user-working-style',
    localFile: 'user_working_style.md',
    label: 'working style',
  });

  // Default security rules (always)
  await createNote(config, {
    content: DEFAULT_SECURITY_RULES,
    type: 'feedback',
    upsertKey: 'feedback-no-read-env',
    localFile: 'feedback_no_read_env.md',
    label: 'security rules',
  });

  // Default knowledge rules (always)
  await createNote(config, {
    content: DEFAULT_KNOWLEDGE_RULES,
    type: 'feedback',
    upsertKey: 'feedback-knowledge-system',
    localFile: 'feedback_knowledge_system.md',
    label: 'knowledge system rules',
  });

  console.error('\nPersona created. Run `ledger pull` to sync locally, or `ledger setup <platform>` if not done yet.');
}

// --- Helper ---

interface NoteInput {
  content: string;
  type: string;
  upsertKey: string;
  localFile: string;
  label: string;
}

async function createNote(config: LedgerConfig, input: NoteInput): Promise<void> {
  const { content, type, upsertKey, localFile, label } = input;

  // Check for existing note with same upsert_key
  const { data: existing } = await config.supabase
    .from('notes')
    .select('id')
    .eq('metadata->>upsert_key', upsertKey)
    .limit(1)
    .single();

  if (existing) {
    console.error(`  skip "${label}" (already exists)`);
    return;
  }

  const embeddingResponse = await config.openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const { error } = await config.supabase
    .from('notes')
    .insert({
      content,
      metadata: {
        type,
        agent: 'ledger-onboard',
        upsert_key: upsertKey,
        local_file: localFile,
        local_cache: true,
        content_hash: contentHash(content),
      },
      embedding,
    });

  if (error) {
    console.error(`  error creating "${label}": ${error.message}`);
    return;
  }

  console.error(`  created "${label}"`);
}
