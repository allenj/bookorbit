import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { ACTIVE_STORYTELLER_JOB_STATUSES, STORYTELLER_JOB_STATUSES } from '@bookorbit/types';

import { storytellerJobs } from './storyteller';

const dialect = new PgDialect();

function quotedLiterals(value: Parameters<PgDialect['sqlToQuery']>[0]): string[] {
  return [...dialect.sqlToQuery(value).sql.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

describe('storyteller_jobs status SQL matches the shared constants', () => {
  const config = getTableConfig(storytellerJobs);

  it('accepts exactly the statuses declared in @bookorbit/types', () => {
    const check = config.checks.find((c) => c.name === 'storyteller_jobs_status_chk');
    expect(check).toBeDefined();
    expect(quotedLiterals(check!.value).sort()).toEqual([...STORYTELLER_JOB_STATUSES].sort());
  });

  it.each(['storyteller_jobs_active_book_uidx', 'storyteller_jobs_active_updated_at_idx'])('scopes %s to exactly the active statuses', (name) => {
    const index = config.indexes.find((i) => i.config.name === name);
    expect(index?.config.where).toBeDefined();
    expect(quotedLiterals(index!.config.where!).sort()).toEqual([...ACTIVE_STORYTELLER_JOB_STATUSES].sort());
  });

  it('allows only one live job per book', () => {
    const index = config.indexes.find((i) => i.config.name === 'storyteller_jobs_active_book_uidx');
    expect(index?.config.unique).toBe(true);
  });
});
