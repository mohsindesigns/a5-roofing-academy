import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { ai } from '@a5/contracts';
import {
  isUniqueViolation,
  likePattern,
  paginate,
  sql,
  type Page,
  type Selectable,
} from '@a5/database';
import { ConflictError, EventBus, InjectDb, NotFoundError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { iso } from '../common/people.js';
import type { AiPersonasTable, Db } from '../database/index.js';
import { PromptVersionService } from '../scenarios/prompt-versions.service.js';

type Row = Selectable<AiPersonasTable> & { scenario_count: number };

function toDto(r: Row): ai.Persona {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    temperament: r.temperament,
    speakingStyle: r.speaking_style,
    background: r.background,
    traits: r.traits,
    archived: r.archived_at !== null,
    scenarioCount: Number(r.scenario_count),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

@Injectable()
export class PersonasService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly versions: PromptVersionService,
  ) {}

  private base(organizationId: string) {
    return this.db
      .selectFrom('ai_personas as p')
      .selectAll('p')
      .select(
        sql<number>`(select count(*)::int from ai_scenarios s where s.persona_id = p.id and s.status <> 'archived')`.as(
          'scenario_count',
        ),
      )
      .where('p.organization_id', '=', organizationId);
  }

  async list(
    p: Principal,
    q: { q?: string; includeArchived?: boolean; page: number; pageSize: number },
  ): Promise<Page<ai.Persona>> {
    let query = this.base(p.organizationId);
    if (!q.includeArchived) query = query.where('p.archived_at', 'is', null);
    if (q.q) query = query.where('p.name', 'ilike', likePattern(q.q));
    const page = await paginate(query.orderBy('p.name'), q);
    return { ...page, items: page.items.map(toDto) };
  }

  async get(p: Principal, id: string): Promise<ai.Persona> {
    const row = await this.base(p.organizationId).where('p.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError('Persona');
    return toDto(row);
  }

  async create(p: Principal, input: ai.CreatePersonaRequest): Promise<ai.Persona> {
    const id = uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('ai_personas')
          .values({
            id,
            organization_id: p.organizationId,
            name: input.name,
            description: input.description,
            temperament: input.temperament,
            speaking_style: input.speakingStyle,
            background: input.background,
            traits: JSON.stringify(input.traits),
            archived_at: null,
            created_by: p.userId,
            updated_by: p.userId,
          })
          .execute();
        await this.events.audit(
          trx,
          {
            action: 'ai.persona.created',
            resourceType: 'ai_persona',
            resourceId: id,
            actorDisplay: p.displayName,
            after: input,
          },
          { organizationId: p.organizationId },
        );
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError(
          'PERSONA_NAME_TAKEN',
          `A persona named "${input.name}" already exists. Choose another name.`,
        );
      throw err;
    }
    return this.get(p, id);
  }

  async update(p: Principal, id: string, input: ai.UpdatePersonaRequest): Promise<ai.Persona> {
    const before = await this.get(p, id);
    if (before.archived)
      throw new ConflictError(
        'PERSONA_ARCHIVED',
        'This persona is archived. Create a new persona instead of editing it.',
      );
    const { changeNote, ...fields } = input;
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('ai_personas')
          .set({
            ...(fields.name !== undefined && { name: fields.name }),
            ...(fields.description !== undefined && { description: fields.description }),
            ...(fields.temperament !== undefined && { temperament: fields.temperament }),
            ...(fields.speakingStyle !== undefined && { speaking_style: fields.speakingStyle }),
            ...(fields.background !== undefined && { background: fields.background }),
            ...(fields.traits !== undefined && { traits: JSON.stringify(fields.traits) }),
            revision: sql<number>`revision + 1`,
            updated_by: p.userId,
          })
          .where('id', '=', id)
          .execute();
        await this.versions.syncForPersona(
          trx,
          id,
          p.userId,
          changeNote ?? `Persona "${fields.name ?? before.name}" updated`,
        );
        await this.events.audit(
          trx,
          {
            action: 'ai.persona.updated',
            resourceType: 'ai_persona',
            resourceId: id,
            actorDisplay: p.displayName,
            before,
            after: fields,
          },
          { organizationId: p.organizationId },
        );
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError(
          'PERSONA_NAME_TAKEN',
          `A persona named "${fields.name}" already exists. Choose another name.`,
        );
      throw err;
    }
    return this.get(p, id);
  }

  async archive(p: Principal, id: string): Promise<ai.Persona> {
    const persona = await this.get(p, id);
    if (persona.scenarioCount > 0) {
      throw new ConflictError(
        'PERSONA_IN_USE',
        `${persona.scenarioCount} scenario(s) still use this persona. Move them to another persona or archive them first.`,
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('ai_personas')
        .set({ archived_at: new Date(), updated_by: p.userId })
        .where('id', '=', id)
        .execute();
      await this.events.audit(
        trx,
        {
          action: 'ai.persona.archived',
          resourceType: 'ai_persona',
          resourceId: id,
          actorDisplay: p.displayName,
        },
        { organizationId: p.organizationId },
      );
    });
    return this.get(p, id);
  }
}
