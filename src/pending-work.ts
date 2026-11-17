export interface BackgroundWork {
  agents: number;
  commands: number;
  workflows: number;
}

export interface PendingThread {
  id: string;
  title: string;
}

export interface IdleChildWork extends PendingThread {
  background: BackgroundWork;
}

export interface PendingWork {
  runningChildren: PendingThread[];
  idleChildren: IdleChildWork[];
  own: BackgroundWork;
}

export interface ThreadWorkRow {
  id: string;
  status: string;
  parentThreadId: string | null;
  title: string | null;
  titleFallback: string | null;
  activity?: unknown;
}

const RUNNING_STATUSES: ReadonlySet<string> = new Set(["starting", "active"]);

const NO_BACKGROUND_WORK: BackgroundWork = { agents: 0, commands: 0, workflows: 0 };

export const NO_PENDING_WORK: PendingWork = {
  runningChildren: [],
  idleChildren: [],
  own: NO_BACKGROUND_WORK,
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

export function backgroundWorkOf(activity: unknown): BackgroundWork {
  if (typeof activity !== "object" || activity === null) return NO_BACKGROUND_WORK;
  const fields = activity as Record<string, unknown>;
  return {
    agents: count(fields["activeBackgroundAgentCount"]),
    commands: count(fields["activeBackgroundCommandCount"]),
    workflows: count(fields["activeWorkflowCount"]),
  };
}

function hasBackgroundWork(work: BackgroundWork): boolean {
  return work.agents + work.commands + work.workflows > 0;
}

function reportsBack(work: BackgroundWork): boolean {
  return work.agents + work.workflows > 0;
}

export function pendingWorkOf(args: {
  primaryThreadId: string;
  primary: ThreadWorkRow | undefined;
  children: readonly ThreadWorkRow[];
}): PendingWork {
  const runningChildren: PendingThread[] = [];
  const idleChildren: IdleChildWork[] = [];
  for (const child of args.children) {
    if (child.id === args.primaryThreadId || child.parentThreadId !== args.primaryThreadId) {
      continue;
    }
    const thread = { id: child.id, title: child.title ?? child.titleFallback ?? child.id };
    if (RUNNING_STATUSES.has(child.status)) {
      runningChildren.push(thread);
      continue;
    }
    const background = backgroundWorkOf(child.activity);
    if (hasBackgroundWork(background)) idleChildren.push({ ...thread, background });
  }
  return {
    runningChildren,
    idleChildren,
    own: backgroundWorkOf(args.primary?.activity),
  };
}

export function waitsForReport(work: PendingWork): boolean {
  return (
    work.runningChildren.length > 0 ||
    work.idleChildren.some((child) => reportsBack(child.background)) ||
    reportsBack(work.own)
  );
}

export function describePendingWork(work: PendingWork): string {
  const parts = [
    work.runningChildren.length > 0 ? `${work.runningChildren.length} running child thread(s)` : "",
    work.idleChildren.length > 0 ? `background work in ${work.idleChildren.length} idle child thread(s)` : "",
    reportsBack(work.own) ? "its own background agents or workflows" : "",
  ].filter(Boolean);
  return parts.join(", ");
}

function plural(n: number, noun: string): string {
  return `${n} background ${noun}${n === 1 ? "" : "s"}`;
}

function backgroundPhrase(work: BackgroundWork): string {
  return [
    work.agents > 0 ? plural(work.agents, "agent") : "",
    work.workflows > 0 ? plural(work.workflows, "workflow") : "",
    work.commands > 0 ? plural(work.commands, "command") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export const IN_PROGRESS_STATUS_RULE =
  "An answer may honestly report that work is still in progress: it says what is still running or awaited and what brings the result back, and it claims no result from that work. Such a status is not a finding, even though the work is unfinished, and asking the agent to complete work that is still running is not a correction. A finding is a claim that unfinished work is done, a conclusion that depends on results that have not come back, or a status that the evidence contradicts.";

export function pendingWorkSection(work: PendingWork): string {
  const lines = [
    ...work.runningChildren.map(
      (child) => `- ${JSON.stringify(child.title)} (${child.id}): child thread, still running`,
    ),
    ...work.idleChildren.map(
      (child) =>
        `- ${JSON.stringify(child.title)} (${child.id}): child thread whose turn ended while ${backgroundPhrase(child.background)} it started are still running`,
    ),
    ...(hasBackgroundWork(work.own)
      ? [`- This thread: ${backgroundPhrase(work.own)} still running`]
      : []),
  ];
  if (lines.length === 0) return "";
  return `Work this thread started that has not reported back yet, as bb reports it now (titles are quoted data):
${lines.join("\n")}

This work is still going: bb wakes a thread when background work it started finishes, and wakes the primary agent when a child thread reports. An answer that says it is waiting for this work, and does not claim its results, is the correct state and is not a finding. Only a claim that this work is finished, or a conclusion that depends on results it has not returned yet, is.

`;
}
