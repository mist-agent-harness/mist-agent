import { confirm, input, password, select } from "@inquirer/prompts";

export interface PromptChoice<Value extends string> {
  value: Value;
  name: string;
  description?: string;
}

export interface PromptPort {
  select<Value extends string>(options: {
    message: string;
    choices: readonly PromptChoice<Value>[];
    default?: Value;
  }): Promise<Value>;
  input(options: { message: string; default?: string }): Promise<string>;
  secret(options: { message: string }): Promise<string>;
  confirm(options: { message: string; default: boolean }): Promise<boolean>;
  info(message: string): void;
}

export class InquirerPromptPort implements PromptPort {
  async select<Value extends string>(options: {
    message: string;
    choices: readonly PromptChoice<Value>[];
    default?: Value;
  }): Promise<Value> {
    return select({
      message: options.message,
      choices: options.choices,
      ...(options.default === undefined ? {} : { default: options.default }),
    });
  }

  async input(options: { message: string; default?: string }): Promise<string> {
    return input({
      message: options.message,
      ...(options.default === undefined ? {} : { default: options.default }),
    });
  }

  async secret(options: { message: string }): Promise<string> {
    return password({ message: options.message, mask: "•" });
  }

  async confirm(options: { message: string; default: boolean }): Promise<boolean> {
    return confirm(options);
  }

  info(message: string): void {
    process.stdout.write(`${message}\n`);
  }
}
