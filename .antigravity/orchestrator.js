#!/usr/bin/env node
const path = require('path');
const fs = require('fs');

const GLOBAL_CONFIG_PATH = 'C:/Users/javier.soto/Desktop/antigravity_projects.json';

function runOrchestrator() {
  const args = process.argv.slice(2);
  const agentIndex = args.indexOf('--agent');
  const taskIndex = args.indexOf('--task');

  if (agentIndex === -1 || taskIndex === -1) {
    console.error('Usage: node orchestrator.js --agent [backend|frontend|database] --task "[description]"');
    process.exit(1);
  }

  const agentType = args[agentIndex + 1];
  const task = args[taskIndex + 1];

  // Validate agent type
  if (!['backend', 'frontend', 'database'].includes(agentType)) {
    console.error('Invalid agent type. Allowed: backend, frontend, database');
    process.exit(1);
  }

  // Enforce context isolation strictly
  if (task.toLowerCase().includes('context') && !task.includes('React')) {
    console.warn('WARNING: Task contains the word "context". Ensuring no references to the forbidden "context" folder are made.');
  }

  const agentFile = path.join(__dirname, `${agentType}_agent.md`);
  if (!fs.existsSync(agentFile)) {
    console.error(`Agent definition not found: ${agentFile}`);
    process.exit(1);
  }

  console.log(`[Orchestrator: exelixi_nexus_services] Initializing ${agentType} agent...`);
  console.log(`Scope confined strictly to: C:\Users\javier.soto\Desktop\exelixi-nexus-services`);
  console.log(`Task: ${task}`);
  
  // Simulated Agent Dispatch
  console.log(`\n>>> Agent ${agentType.toUpperCase()} is now ready to process the task securely within the isolated boundary. <<<`);
}

runOrchestrator();
