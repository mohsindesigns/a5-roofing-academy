import { Injectable } from '@nestjs/common';
import type { PersonRef } from '@a5/contracts';
import { DirectoryReader } from '@a5/directory';

/** Resolves user ids to display names through the local directory projection. */
@Injectable()
export class People {
  constructor(private readonly directory: DirectoryReader) {}

  async refs(ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, PersonRef>> {
    const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
    const users = await this.directory.getUsers(wanted);
    return new Map(
      wanted.map((id) => [id, { id, displayName: users.get(id)?.displayName ?? 'Unknown user' }]),
    );
  }

  async ref(id: string | null | undefined): Promise<PersonRef | null> {
    if (!id) return null;
    return (await this.refs([id])).get(id) ?? null;
  }
}

export function refOrNull(
  map: Map<string, PersonRef>,
  id: string | null | undefined,
): PersonRef | null {
  return id ? (map.get(id) ?? null) : null;
}
