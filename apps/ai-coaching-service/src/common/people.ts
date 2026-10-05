import { Injectable } from '@nestjs/common';
import { DirectoryReader } from '@a5/directory';

export interface PersonRef {
  id: string;
  displayName: string;
}

/** Display names from the directory projection (never a synchronous call to identity). */
@Injectable()
export class People {
  constructor(private readonly directory: DirectoryReader) {}

  async refs(ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, PersonRef>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const users = await this.directory.getUsers(wanted);
    return new Map(wanted.map((id) => [id, { id, displayName: users.get(id)?.displayName ?? 'Former team member' }]));
  }

  async ref(id: string | null | undefined): Promise<PersonRef | null> {
    if (!id) return null;
    return (await this.refs([id])).get(id) ?? null;
  }
}

export const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
export const isoOrNull = (d: Date | string | null | undefined): string | null => (d ? iso(d) : null);
