import { logger } from '../utils/logger.js';

// ANSI color codes for console logging
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
};

/**
 * A dedicated tracer for logging the conversational flow in a structured and readable way.
 * This meets the critical requirement for debugging and understanding agent decisions.
 */
class Tracer {
  log(message: string) {
    process.stdout.write(message);
  }

  userInput(message: string) {
    this.log(`\n${colors.cyan}[User]:${colors.reset} "${message}"\n`);
  }

  decision(agent: string, decision: string, reason: string) {
    this.log(`${colors.yellow}[Decision | ${agent}]:${colors.reset} ${decision}. Reason: ${reason}\n`);
  }

  route(from: string, to: string) {
    this.log(`${colors.magenta}[LangGraph]:${colors.reset} Routed ${from} → ${to}\n`);
  }

  agentResponse(agent: string, response: string) {
    this.log(`${colors.green}[Agent | ${agent}]:${colors.reset} "${response}"\n`);
  }

  error(agent: string, error: string) {
    this.log(`${colors.red}[Error | ${agent}]:${colors.reset} ${error}\n`);
  }
}

export const tracer = new Tracer();
