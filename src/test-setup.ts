import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A test that reaches the database without choosing one gets a scratch
// file, never local-data/ (the developer's own data). Test files that set
// DATABASE_PATH themselves keep theirs.
process.env.DATABASE_PATH ??= join(mkdtempSync(join(tmpdir(), 'zajel-test-')), 'test.db');
