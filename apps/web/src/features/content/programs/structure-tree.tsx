import { useRef, useState, type DragEvent, type MutableRefObject, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Lock,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import { describeRule, type RuleLabelResolver } from '@a5/rules';
import {
  Button,
  IconButton,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Tag,
} from '@/components/ui';
import type { learning } from '@a5/contracts';
import { LessonTypeIcon, lessonTypeLabel } from '@/features/learning/lesson-ui';
import { cn } from '@/lib/cn';
import {
  planDrop,
  planStep,
  type DropTarget,
  type Lesson,
  type MovePlan,
  type Module,
  type NodeKind,
  type Phase,
} from './tree';

export interface TreeActions {
  move: (plan: MovePlan | null) => void;
  /** Keyboard / button moves also say what happened. */
  step: (kind: NodeKind, id: string, direction: -1 | 1) => void;
  moveTo: (kind: 'module' | 'lesson', id: string, parentId: string) => void;
  editLesson: (id: string) => void;
  addLesson: (moduleId: string) => void;
  addModule: (phaseId: string) => void;
  editNode: (kind: 'phase' | 'module', id: string) => void;
  editRule: (kind: 'phase' | 'module', id: string) => void;
  setArchived: (kind: 'phase' | 'module' | 'lesson', id: string, archived: boolean) => void;
  duplicateLesson: (id: string) => void;
  remove: (kind: 'phase' | 'module' | 'lesson', id: string) => void;
}

interface Hint {
  kind: NodeKind;
  id: string;
  where: 'before' | 'after' | 'into';
}

const STATUS_TAG = (status: learning.NodeStatus, unpublished: boolean): ReactNode =>
  status === 'archived' ? (
    <Tag>Archived</Tag>
  ) : status === 'draft' ? (
    <Tag tone="warning">Draft</Tag>
  ) : unpublished ? (
    <Tag tone="warning">Edited</Tag>
  ) : null;

function RuleLine({ rule, resolver }: { rule: Phase['unlockRule']; resolver: RuleLabelResolver }) {
  if (!rule) return null;
  const text = describeRule(rule, resolver);
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-text-tertiary" title={text}>
      <Lock aria-hidden className="size-3 shrink-0" />
      <span className="truncate">Unlock rule: {text}</span>
    </p>
  );
}

interface RowProps {
  kind: NodeKind;
  id: string;
  title: string;
  canEdit: boolean;
  phases: Phase[];
  hint: Hint | null;
  onHint: (h: Hint | null) => void;
  actions: TreeActions;
  dragRef: MutableRefObject<{ kind: NodeKind; id: string } | null>;
  /** Names for the unlock-rule summaries. */
  resolver: RuleLabelResolver;
  /** Archived siblings are skipped by move up / down unless they are shown. */
  includeArchived: boolean;
  className?: string;
  children: ReactNode;
  menu: ReactNode;
}

/** One draggable, drop-aware row with keyboard-accessible move buttons and an actions menu. */
function Row({
  kind,
  id,
  title,
  canEdit,
  phases,
  hint,
  onHint,
  actions,
  dragRef,
  includeArchived,
  className,
  children,
  menu,
}: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const up = planStep(phases, kind, id, -1, { includeArchived });
  const down = planStep(phases, kind, id, 1, { includeArchived });

  const targetFor = (e: DragEvent): DropTarget | null => {
    const drag = dragRef.current;
    if (!drag) return null;
    if (drag.kind === 'lesson' && kind === 'module') return { kind, id, where: 'into' };
    if (drag.kind === 'module' && kind === 'phase') return { kind, id, where: 'into' };
    if (drag.kind !== kind) return null;
    const rect = rowRef.current!.getBoundingClientRect();
    return { kind, id, where: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after' };
  };

  const active = hint && hint.kind === kind && hint.id === id ? hint.where : null;
  return (
    <div
      ref={rowRef}
      data-node={`${kind}:${id}`}
      draggable={canEdit}
      onDragStart={(e) => {
        e.stopPropagation();
        dragRef.current = { kind, id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${kind}:${id}`);
      }}
      onDragEnd={() => {
        dragRef.current = null;
        onHint(null);
      }}
      onDragOver={(e) => {
        const drag = dragRef.current;
        const target = targetFor(e);
        if (!drag || !target || !planDrop(phases, drag, target)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (hint?.kind !== kind || hint.id !== id || hint.where !== target.where)
          onHint({ kind, id, where: target.where });
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHint(null);
      }}
      onDrop={(e) => {
        const drag = dragRef.current;
        const target = targetFor(e);
        dragRef.current = null;
        onHint(null);
        if (!drag || !target) return;
        e.preventDefault();
        e.stopPropagation();
        actions.move(planDrop(phases, drag, target));
      }}
      className={cn(
        'group flex items-center gap-2 rounded px-2 py-2',
        active === 'before' && 'shadow-[inset_0_2px_0_0_var(--a5-focus)]',
        active === 'after' && 'shadow-[inset_0_-2px_0_0_var(--a5-focus)]',
        active === 'into' && 'bg-information-soft outline outline-1 outline-information',
        className,
      )}
    >
      {canEdit && (
        <GripVertical
          aria-hidden
          className="size-4 shrink-0 cursor-grab text-text-tertiary opacity-60 group-hover:opacity-100"
        />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {canEdit && (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={`Move ${title} up`}
            size="sm"
            data-focus-key={`${kind}:${id}:up`}
            disabled={!up}
            onClick={() => actions.step(kind, id, -1)}
          >
            <ChevronUp className="size-4" />
          </IconButton>
          <IconButton
            label={`Move ${title} down`}
            size="sm"
            data-focus-key={`${kind}:${id}:down`}
            disabled={!down}
            onClick={() => actions.step(kind, id, 1)}
          >
            <ChevronDown className="size-4" />
          </IconButton>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton label={`More actions for ${title}`} size="sm">
                <MoreHorizontal className="size-4" />
              </IconButton>
            </MenuTrigger>
            <MenuContent className="max-h-[420px] overflow-y-auto">{menu}</MenuContent>
          </MenuRoot>
        </div>
      )}
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
      className="flex size-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
    >
      {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
    </button>
  );
}

function LessonRow({
  lesson,
  module,
  phases,
  ...shared
}: { lesson: Lesson; module: Module; phases: Phase[] } & Omit<
  RowProps,
  'kind' | 'id' | 'title' | 'children' | 'menu' | 'phases'
>) {
  const { actions } = shared;
  const archived = lesson.status === 'archived';
  const targets = phases.flatMap((p) =>
    p.modules.filter((m) => m.status !== 'archived' && m.id !== module.id).map((m) => ({ m, p })),
  );
  return (
    <Row
      {...shared}
      phases={phases}
      kind="lesson"
      id={lesson.id}
      title={lesson.title}
      className={cn(archived && 'opacity-60')}
      menu={
        <>
          <MenuItem onSelect={() => actions.editLesson(lesson.id)}>Edit lesson</MenuItem>
          <MenuItem onSelect={() => actions.duplicateLesson(lesson.id)}>Duplicate</MenuItem>
          {targets.length > 0 && <MenuSeparator />}
          {targets.length > 0 && <MenuLabel>Move to the end of</MenuLabel>}
          {targets.map(({ m, p }) => (
            <MenuItem key={m.id} onSelect={() => actions.moveTo('lesson', lesson.id, m.id)}>
              {p.label} › {m.title}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => actions.setArchived('lesson', lesson.id, !archived)}>
            {archived ? 'Restore' : 'Archive'}
          </MenuItem>
          <MenuItem tone="danger" onSelect={() => actions.remove('lesson', lesson.id)}>
            Delete…
          </MenuItem>
        </>
      }
    >
      <LessonTypeIcon type={lesson.type} className="size-4 shrink-0 text-text-tertiary" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <button
            type="button"
            className="min-w-0 truncate rounded text-left text-base font-medium hover:underline"
            onClick={() => actions.editLesson(lesson.id)}
          >
            {lesson.title}
          </button>
          {STATUS_TAG(lesson.status, lesson.hasUnpublishedChanges)}
        </p>
        <p className="truncate text-xs text-text-tertiary">
          {lessonTypeLabel(lesson.type)}
          {lesson.estimatedMinutes > 0 && ` · ${lesson.estimatedMinutes} min`}
          {!lesson.isRequired && ' · Optional'}
        </p>
        <RuleLine rule={lesson.unlockRule} resolver={shared.resolver} />
      </div>
    </Row>
  );
}

function ModuleBlock({
  module,
  phase,
  phases,
  showArchived,
  ...shared
}: { module: Module; phase: Phase; phases: Phase[]; showArchived: boolean } & Omit<
  RowProps,
  'kind' | 'id' | 'title' | 'children' | 'menu' | 'phases'
>) {
  const [open, setOpen] = useState(true);
  const { actions } = shared;
  const archived = module.status === 'archived';
  const lessons = module.lessons.filter((l) => showArchived || l.status !== 'archived');
  const otherPhases = phases.filter((p) => p.id !== phase.id && p.status !== 'archived');
  return (
    <div className={cn(archived && 'opacity-60')}>
      <Row
        {...shared}
        phases={phases}
        kind="module"
        id={module.id}
        title={module.title}
        className="bg-surface-sunken/50"
        menu={
          <>
            <MenuItem onSelect={() => actions.editNode('module', module.id)}>Edit details</MenuItem>
            <MenuItem onSelect={() => actions.editRule('module', module.id)}>Unlock rule…</MenuItem>
            <MenuItem onSelect={() => actions.addLesson(module.id)}>Add lesson</MenuItem>
            {otherPhases.length > 0 && <MenuSeparator />}
            {otherPhases.length > 0 && <MenuLabel>Move to the end of</MenuLabel>}
            {otherPhases.map((p) => (
              <MenuItem key={p.id} onSelect={() => actions.moveTo('module', module.id, p.id)}>
                {p.label}: {p.title}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={() => actions.setArchived('module', module.id, !archived)}>
              {archived ? 'Restore' : 'Archive'}
            </MenuItem>
            <MenuItem tone="danger" onSelect={() => actions.remove('module', module.id)}>
              Delete…
            </MenuItem>
          </>
        }
      >
        <Disclosure
          open={open}
          onToggle={() => setOpen((o) => !o)}
          label={`${open ? 'Collapse' : 'Expand'} ${module.title}`}
        />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="truncate text-base font-semibold">{module.title}</span>
            {STATUS_TAG(module.status, module.hasUnpublishedChanges)}
          </p>
          <p className="text-xs text-text-tertiary">
            {module.lessons.filter((l) => l.status !== 'archived').length} lessons
          </p>
          <RuleLine rule={module.unlockRule} resolver={shared.resolver} />
        </div>
      </Row>
      {open && (
        <div className="ml-6 border-l border-divider pl-2">
          {lessons.map((l) => (
            <LessonRow key={l.id} lesson={l} module={module} phases={phases} {...shared} />
          ))}
          {lessons.length === 0 && (
            <p className="px-2 py-2 text-sm text-text-tertiary">No lessons in this module yet.</p>
          )}
          {shared.canEdit && !archived && (
            <div className="px-2 py-1.5">
              <Button
                size="sm"
                variant="ghost"
                leading={<Plus className="size-3.5" />}
                onClick={() => actions.addLesson(module.id)}
              >
                Add lesson
                <span className="sr-only"> to {module.title}</span>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseBlock({
  phase,
  phases,
  showArchived,
  ...shared
}: { phase: Phase; phases: Phase[]; showArchived: boolean } & Omit<
  RowProps,
  'kind' | 'id' | 'title' | 'children' | 'menu' | 'phases'
>) {
  const [open, setOpen] = useState(true);
  const { actions } = shared;
  const archived = phase.status === 'archived';
  const modules = phase.modules.filter((m) => showArchived || m.status !== 'archived');
  return (
    <section
      aria-label={`${phase.label}: ${phase.title}`}
      className={cn('rounded-lg border border-border bg-surface', archived && 'opacity-60')}
    >
      <Row
        {...shared}
        phases={phases}
        kind="phase"
        id={phase.id}
        title={`${phase.label}: ${phase.title}`}
        className="px-3"
        menu={
          <>
            <MenuItem onSelect={() => actions.editNode('phase', phase.id)}>Edit details</MenuItem>
            <MenuItem onSelect={() => actions.editRule('phase', phase.id)}>Unlock rule…</MenuItem>
            <MenuItem onSelect={() => actions.addModule(phase.id)}>Add module</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => actions.setArchived('phase', phase.id, !archived)}>
              {archived ? 'Restore' : 'Archive'}
            </MenuItem>
            <MenuItem tone="danger" onSelect={() => actions.remove('phase', phase.id)}>
              Delete…
            </MenuItem>
          </>
        }
      >
        <Disclosure
          open={open}
          onToggle={() => setOpen((o) => !o)}
          label={`${open ? 'Collapse' : 'Expand'} ${phase.label}`}
        />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="text-xs font-medium text-text-tertiary">{phase.label}</span>
            <span className="truncate text-md font-semibold">{phase.title}</span>
            {STATUS_TAG(phase.status, phase.hasUnpublishedChanges)}
          </p>
          {phase.summary && <p className="truncate text-sm text-text-secondary">{phase.summary}</p>}
          <RuleLine rule={phase.unlockRule} resolver={shared.resolver} />
        </div>
      </Row>
      {open && (
        <div className="grid gap-2 px-3 pb-3">
          {modules.map((m) => (
            <ModuleBlock
              key={m.id}
              module={m}
              phase={phase}
              phases={phases}
              showArchived={showArchived}
              {...shared}
            />
          ))}
          {modules.length === 0 && (
            <p className="px-2 py-2 text-sm text-text-tertiary">No modules in this phase yet.</p>
          )}
          {shared.canEdit && !archived && (
            <div>
              <Button
                size="sm"
                leading={<Plus className="size-3.5" />}
                onClick={() => actions.addModule(phase.id)}
              >
                Add module
                <span className="sr-only"> to {phase.title}</span>
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Program → Phase → Module → Lesson. Reordering works with the mouse (drag a row) and without
 * one (move up / move down buttons on every row, plus "Move to…" in the row menu).
 */
export function StructureTree({
  phases,
  canEdit,
  showArchived,
  actions,
  resolver,
}: {
  phases: Phase[];
  canEdit: boolean;
  showArchived: boolean;
  actions: TreeActions;
  resolver: RuleLabelResolver;
}) {
  const dragRef = useRef<{ kind: NodeKind; id: string } | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const visible = phases.filter((p) => showArchived || p.status !== 'archived');
  return (
    <div className="grid gap-4">
      {visible.map((p) => (
        <PhaseBlock
          key={p.id}
          phase={p}
          phases={phases}
          showArchived={showArchived}
          canEdit={canEdit}
          hint={hint}
          onHint={setHint}
          actions={actions}
          dragRef={dragRef}
          includeArchived={showArchived}
          resolver={resolver}
        />
      ))}
    </div>
  );
}
