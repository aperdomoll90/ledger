import { createInterface } from 'readline';

export async function ask(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function askMasked(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    let input = '';

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (buf: Buffer) => {
      const c = buf.toString();
      if (c === '\n' || c === '\r') {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        process.stderr.write('\n');
        resolve(input.trim());
      } else if (c === '\u007f' || c === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else if (c === '\u0003') {
        // Ctrl+C
        process.exit(1);
      } else {
        input += c;
        process.stderr.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} [y/N] `);
  return answer === 'y' || answer === 'yes';
}

export async function choose(question: string, options: string[]): Promise<string> {
  const optionList = options.map((o, i) => `  ${i + 1}. ${o}`).join('\n');
  const answer = await ask(`${question}\n${optionList}\n> `);

  const index = parseInt(answer, 10) - 1;
  if (index >= 0 && index < options.length) {
    return options[index];
  }

  // Try matching by name
  const match = options.find(o => o.toLowerCase().startsWith(answer));
  return match || options[0];
}
