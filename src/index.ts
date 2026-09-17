import { CONFIG_DIR_NAME, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ControlController, type ControlDependencies } from './commands.js';
import { isActive } from './state.js';
import { registerPlanHandoff } from './plannotator.js';

const commands: Record<string, string> = {
  implement: 'Claim and implement one Backlog task with scope enforcement and bounded repairs',
  'implement-resume': 'Resume a failed or restored task with a fresh repair budget',
  verify: 'Verify the active task without automatic repair',
  'verify-waive': 'Confirm a reasoned waiver of current failed command checks',
  'scope-show': 'Show original task scope and user additions',
  'scope-add': 'Confirm one run-local scope addition',
  'control-status': 'Show active workflow state and verification freshness',
  'control-abort': 'End enforcement without reverting changes',
  commit: 'Confirm and commit current verified or waived task changes',
};

export function registerControl(pi: ExtensionAPI, deps: ControlDependencies = {}): ControlController {
  const control = new ControlController(pi, CONFIG_DIR_NAME, deps);
  for (const [name, description] of Object.entries(commands)) {
    pi.registerCommand(name, { description, handler: (args, ctx) => control.execute(name, args, ctx) });
  }
  pi.on('session_start', (_event, ctx) => control.initialize(ctx));
  pi.on('session_tree', (_event, ctx) => control.initialize(ctx));
  pi.on('agent_settled', (_event, ctx) => control.settled(ctx));
  pi.on('tool_call', event => control.gate(event));
  const unsubscribe = registerPlanHandoff(pi, {
    getContext: () => control.context,
    isEnabled: () => control.config.autoPlanHandoff,
    isRunActive: () => isActive(control.run) || control.busy,
  });
  pi.on('session_shutdown', () => { control.shutdown(); unsubscribe(); });
  return control;
}
export default function piControl(pi: ExtensionAPI): void { registerControl(pi); }
