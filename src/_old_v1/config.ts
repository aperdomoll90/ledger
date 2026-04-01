import { getLedgerDir, type HookConfig, type NamingConfig, saveConfigFile, loadConfigFile } from '../lib/config.js';
import { BUILTIN_TYPES, getTypeRegistry, opUpdateMetadata, validateTypeName, inferDomain, type DeliveryTier, type Clients } from '../lib/notes.js';
import { choose, confirm } from '../lib/prompt.js';
import { resolve } from 'path';

const CONFIG_PATH = resolve(getLedgerDir(), 'config.json');

const SECURITY_WARNINGS: Record<string, string> = {
  envBlocking: 'This disables .env file protection.\nYour API keys and credentials will be readable by the AI agent.',
  mcpJsonBlocking: 'This allows direct editing of mcp.json.\nMCP servers should be registered via `claude mcp add`, not by editing config files.',
};

const DESCRIPTIONS: Record<string, string> = {
  envBlocking: 'Block reading/writing .env and credential files',
  mcpJsonBlocking: 'Block direct editing of mcp.json',
  writeInterception: 'Auto-ingest files written to memory directory into Ledger',
  sessionEndCheck: 'Check for unsynced files at session end',
};

const NAMING_DESCRIPTIONS: Record<string, string> = {
  'naming.enforce': 'Validate upsert_key format on note creation',
  'naming.interactive': 'Prompt for missing metadata when creating notes (default: true)',
};

const DEVICE_DESCRIPTIONS: Record<string, string> = {
  'device.alias': 'Name for this device',
};

export async function configGet(key: string): Promise<void> {
  const config = loadConfigFile();

  if (key === 'all') {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  // Check hooks
  const hookKey = key as keyof HookConfig;
  if (hookKey in (config.hooks || {})) {
    console.log(`${key}: ${config.hooks?.[hookKey]}`);
    return;
  }

  // Check top-level
  if (key in config) {
    console.log(`${key}: ${(config as Record<string, unknown>)[key]}`);
    return;
  }

  // Check naming settings
  if (key === 'naming.enforce') {
    console.log(`naming.enforce: ${config.naming?.enforce ?? false}`);
    return;
  }
  if (key === 'naming.interactive') {
    console.log(`naming.interactive: ${config.naming?.interactive ?? true} (default: true)`);
    return;
  }

  // Check device
  if (key === 'device.alias') {
    console.log(`device.alias: ${config.device?.alias || '(not set)'}`);
    return;
  }

  // Show default
  const defaults: Record<string, unknown> = {
    envBlocking: true,
    mcpJsonBlocking: true,
    writeInterception: true,
    sessionEndCheck: true,
  };

  if (key in defaults) {
    console.log(`${key}: ${defaults[key]} (default)`);
    return;
  }

  // Handle type registry
  if (key === 'types') {
    const registry = getTypeRegistry();
    const userTypes = config.types ?? {};

    console.error('Type registry:');
    for (const [typeName, delivery] of Object.entries(registry)) {
      const isBuiltin = typeName in BUILTIN_TYPES;
      const isOverridden = isBuiltin && typeName in userTypes;
      const isCustom = !isBuiltin;

      let annotation = isCustom ? '(custom)' : '(built-in)';
      if (isOverridden) {
        annotation = `(built-in, overridden — default: ${BUILTIN_TYPES[typeName]})`;
      }
      console.error(`  ${typeName}: ${delivery} ${annotation}`);
    }
    return;
  }

  if (key.startsWith('types.')) {
    const typeName = key.slice(6);
    const registry = getTypeRegistry();
    if (typeName in registry) {
      const isBuiltin = typeName in BUILTIN_TYPES;
      console.log(`${typeName}: ${registry[typeName]} (${isBuiltin ? 'built-in' : 'custom'})`);
    } else {
      console.log(`${typeName}: not registered`);
    }
    return;
  }

  const allKeys = [...Object.keys(DESCRIPTIONS), ...Object.keys(NAMING_DESCRIPTIONS), ...Object.keys(DEVICE_DESCRIPTIONS), 'memoryDir', 'claudeMdPath', 'types', 'all'];
  console.error(`Unknown config key: ${key}`);
  console.error(`Available: ${allKeys.join(', ')}`);
  process.exit(1);
}

export async function configSet(key: string, value: string, clients?: Clients): Promise<void> {
  const config = loadConfigFile();

  // Handle hook settings
  const hookKeys = ['envBlocking', 'mcpJsonBlocking', 'writeInterception', 'sessionEndCheck'];

  if (hookKeys.includes(key)) {
    const boolValue = value === 'true';

    // Disabling a security feature — warn and double confirm
    if (!boolValue && key in SECURITY_WARNINGS) {
      console.error(`\nWARNING: ${SECURITY_WARNINGS[key]}\n`);
      const first = await confirm('Are you sure?');
      if (!first) {
        console.error('Cancelled.');
        return;
      }
      const second = await confirm(`Confirm: disable ${key}?`);
      if (!second) {
        console.error('Cancelled.');
        return;
      }
    }

    if (!config.hooks) config.hooks = {};
    config.hooks[key as keyof HookConfig] = boolValue;
    saveConfigFile(config);

    const state = boolValue ? 'enabled' : 'disabled';
    console.error(`${key}: ${state}`);
    console.error('Run `ledger setup claude-code` to apply hook changes.');
    return;
  }

  // Handle naming settings
  const namingKeys = ['naming.enforce', 'naming.interactive'];
  if (namingKeys.includes(key)) {
    const boolValue = value === 'true';
    if (!config.naming) config.naming = {};
    const field = key.split('.')[1] as keyof NamingConfig;
    config.naming[field] = boolValue;
    saveConfigFile(config);
    console.error(`${key}: ${boolValue ? 'enabled' : 'disabled'}`);
    return;
  }

  // Handle device alias
  if (key === 'device.alias') {
    config.device = { alias: value };
    saveConfigFile(config);
    console.error(`device.alias: ${value}`);
    return;
  }

  // Handle path settings
  if (key === 'memoryDir' || key === 'claudeMdPath') {
    (config as Record<string, unknown>)[key] = value;
    saveConfigFile(config);
    console.error(`${key}: ${value}`);
    return;
  }

  // Handle type registry
  if (key.startsWith('types.')) {
    const typeName = key.slice(6);
    const delivery = value as DeliveryTier;

    if (!['persona', 'project', 'knowledge', 'protected'].includes(delivery)) {
      console.error(`Invalid domain/delivery: "${value}". Must be: persona, project, knowledge, or protected.`);
      process.exit(1);
    }

    const nameError = validateTypeName(typeName);
    if (nameError) {
      console.error(nameError);
      process.exit(1);
    }

    const oldDelivery = config.types?.[typeName] ?? BUILTIN_TYPES[typeName];
    if (!config.types) config.types = {};
    config.types[typeName] = delivery;
    saveConfigFile(config);

    const isBuiltin = typeName in BUILTIN_TYPES;
    const action = isBuiltin ? 'overridden' : 'registered';
    console.error(`types.${typeName}: ${delivery} (${action})`);

    // Domain change propagation — only if we have DB access and delivery actually changed
    if (clients && oldDelivery && oldDelivery !== delivery) {
      const newDomain = inferDomain(typeName);
      const { data: notes } = await clients.supabase
        .from('notes')
        .select('id, metadata')
        .eq('metadata->>type', typeName);

      const affected = (notes ?? []).filter(
        (n: { id: number; metadata: Record<string, unknown> }) =>
          (n.metadata.domain as string) !== newDomain
      );

      if (affected.length > 0) {
        console.error(`\n${affected.length} note(s) currently have a different domain:`);
        for (const note of affected) {
          const meta = note.metadata as Record<string, unknown>;
          const uKey = (meta.upsert_key as string) || `id-${note.id}`;
          console.error(`  [${note.id}] ${uKey} — domain: ${meta.domain}`);
        }

        const action = await choose('\nUpdate domain on these notes?', [
          'all — update all notes',
          'select — choose individually',
          'none — only affect new notes',
        ]);

        if (action.startsWith('all')) {
          for (const note of affected) {
            await opUpdateMetadata(clients, note.id, { domain: newDomain });
          }
          console.error(`Updated domain to "${newDomain}" on ${affected.length} note(s).`);
        } else if (action.startsWith('select')) {
          let updated = 0;
          for (const note of affected) {
            const meta = note.metadata as Record<string, unknown>;
            const uKey = (meta.upsert_key as string) || `id-${note.id}`;
            const yes = await confirm(`  Update [${note.id}] ${uKey}?`);
            if (yes) {
              await opUpdateMetadata(clients, note.id, { domain: newDomain });
              updated++;
            }
          }
          console.error(`Updated domain on ${updated} note(s).`);
        }
      }
    }
    return;
  }

  const allKeys = [...hookKeys, ...namingKeys, 'device.alias', 'memoryDir', 'claudeMdPath', 'types.*'];
  console.error(`Unknown config key: ${key}`);
  console.error(`Available: ${allKeys.join(', ')}`);
  process.exit(1);
}

export async function configUnset(key: string, clients?: Clients): Promise<void> {
  if (!key.startsWith('types.')) {
    console.error(`Unset is only supported for types.* keys. Got: ${key}`);
    process.exit(1);
  }

  const typeName = key.slice(6);
  const config = loadConfigFile();
  const userTypes = config.types ?? {};

  if (!(typeName in userTypes)) {
    console.error(`No user override for "${typeName}".`);
    return;
  }

  const isBuiltin = typeName in BUILTIN_TYPES;

  if (!isBuiltin && clients) {
    const { data: notes } = await clients.supabase
      .from('notes')
      .select('id')
      .eq('metadata->>type', typeName);

    if (notes && notes.length > 0) {
      console.error(`\n${notes.length} note(s) use type "${typeName}". They will become unregistered (domain defaults to "project").`);
      const proceed = await confirm('Proceed?');
      if (!proceed) {
        console.error('Cancelled.');
        return;
      }
    }
  }

  delete config.types![typeName];
  if (config.types && Object.keys(config.types).length === 0) delete config.types;
  saveConfigFile(config);

  if (isBuiltin) {
    console.error(`Reverted "${typeName}" to built-in default: ${BUILTIN_TYPES[typeName]}`);
  } else {
    console.error(`Removed custom type "${typeName}".`);
  }
}

export async function configList(): Promise<void> {
  const config = loadConfigFile();
  const hooks = config.hooks || {};

  console.error('Hook settings:');
  for (const [key, desc] of Object.entries(DESCRIPTIONS)) {
    const value = hooks[key as keyof HookConfig] ?? true;
    const state = value ? 'enabled' : 'DISABLED';
    console.error(`  ${key}: ${state} — ${desc}`);
  }

  console.error('\nNaming settings:');
  for (const [key, desc] of Object.entries(NAMING_DESCRIPTIONS)) {
    const field = key.split('.')[1] as keyof NamingConfig;
    const defaultVal = field === 'interactive' ? true : false;
    const value = config.naming?.[field] ?? defaultVal;
    const state = value ? 'enabled' : 'DISABLED';
    console.error(`  ${key}: ${state} — ${desc}`);
  }

  console.error('\nDevice:');
  console.error(`  device.alias: ${config.device?.alias || '(not set)'}`);

  console.error('\nPaths:');
  console.error(`  memoryDir: ${config.memoryDir || '(default)'}`);
  console.error(`  claudeMdPath: ${config.claudeMdPath || '(default)'}`);

  const registry = getTypeRegistry();
  const userTypes = config.types ?? {};
  const customTypes = Object.keys(userTypes).filter(t => !(t in BUILTIN_TYPES));
  const overrides = Object.keys(userTypes).filter(t => t in BUILTIN_TYPES);

  console.error('\nType registry:');
  if (customTypes.length > 0) {
    console.error(`  Custom types: ${customTypes.map(t => `${t} (${userTypes[t]})`).join(', ')}`);
  }
  if (overrides.length > 0) {
    console.error(`  Overrides: ${overrides.map(t => `${t}: ${userTypes[t]} (default: ${BUILTIN_TYPES[t]})`).join(', ')}`);
  }
  if (customTypes.length === 0 && overrides.length === 0) {
    console.error('  No custom types or overrides. Using built-in defaults.');
  }
  console.error(`  Built-in types: ${Object.keys(BUILTIN_TYPES).length}`);

  console.error('\nConfig file: ' + CONFIG_PATH);
}
