// ANSI color codes for console logging
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  gray: "\x1b[90m"
};

/**
 * A dedicated tracer for logging the conversational flow in a structured and readable way.
 */
class Tracer {
  private log(message: string) {
    process.stdout.write(message);
  }

  info(message: string, data?: any) {
    const formattedData = data ? `\n${colors.gray}${JSON.stringify(data, null, 2)}${colors.reset}` : '';
    this.log(`${colors.blue}[Info]:${colors.reset} ${message}${formattedData}\n`);
  }

  userInput(message: string) {
    this.log(`\n\n${'='.repeat(50)}\n${colors.cyan}[User Input]:${colors.reset} "${message}"\n${'-'.repeat(50)}\n`);
  }

  decision(agent: string, data: { decision: string; reasoning: string }) {
    this.log(`${colors.yellow}[Decision | ${agent}]:${colors.reset} Route to ${colors.yellow}${data.decision}${colors.reset}. Reason: ${data.reasoning}\n`);
  }

  route(from: string, to: string) {
    this.log(`${colors.magenta}[Route]:${colors.reset} ${from} → ${colors.magenta}${to}${colors.reset}\n`);
  }

  agentResponse(agent: string, response: any) {
    const formattedResponse = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
    this.log(`${colors.green}[Agent Response | ${agent}]:${colors.reset}\n${formattedResponse}\n`);
  }

  error(agent: string, message: string, error?: any) {
    const errorDetails = error ? `: ${error.message || JSON.stringify(error)}` : '';
    this.log(`${colors.red}[Error | ${agent}]:${colors.reset} ${message}${errorDetails}\n`);
  }

  toolCall(toolName: string, args: any) {
    this.log(`${colors.magenta}[Tool Call]:${colors.reset} ${toolName}(${JSON.stringify(args)})\n`);
  }

  toolResult(toolName: string, result: any) {
    const formattedResult = typeof result === 'string' ? result : JSON.stringify(result);
    this.log(`${colors.green}[Tool Result | ${toolName}]:${colors.reset} ${formattedResult}\n`);
  }
}

export const tracer = new Tracer();
