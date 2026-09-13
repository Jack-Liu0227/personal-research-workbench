import type BetterSqlite3 from 'better-sqlite3'

interface Migration {
  readonly id: number
  readonly name: string
  readonly sql: string
  /** SQLite requires foreign-key enforcement to be disabled while rebuilding a
   * table that is referenced by other tables. The migration itself still runs
   * inside the same transaction and the pragma is restored immediately after. */
  readonly disableForeignKeys?: boolean
}

const migrations: readonly Migration[] = [
  {
    id: 1,
    name: 'initial_workbench_schema',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'paused', 'completed', 'archived')),
        start_at TEXT,
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      CREATE INDEX projects_status_idx ON projects(status);
      CREATE INDEX projects_updated_at_idx ON projects(updated_at);

      CREATE TABLE board_columns (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('planned', 'in_progress', 'blocked', 'done')),
        position REAL NOT NULL,
        UNIQUE(project_id, status),
        UNIQUE(project_id, position)
      ) STRICT;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        column_id TEXT REFERENCES board_columns(id) ON DELETE SET NULL,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'inbox'
          CHECK (status IN ('inbox', 'planned', 'in_progress', 'blocked', 'done', 'canceled')),
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes > 0),
        start_at TEXT,
        due_at TEXT,
        completed_at TEXT,
        sort_key REAL NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        CHECK (
          (project_id IS NULL AND column_id IS NULL AND status IN ('inbox', 'canceled'))
          OR project_id IS NOT NULL
        )
      ) STRICT;

      CREATE INDEX tasks_project_column_sort_idx
        ON tasks(project_id, column_id, sort_key);
      CREATE INDEX tasks_status_due_at_idx ON tasks(status, due_at);
      CREATE INDEX tasks_archived_at_idx ON tasks(archived_at);
      CREATE INDEX tasks_completed_at_idx ON tasks(completed_at);

      CREATE VIRTUAL TABLE task_search USING fts5(
        id UNINDEXED,
        title,
        notes,
        content='tasks',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER tasks_search_insert AFTER INSERT ON tasks BEGIN
        INSERT INTO task_search(rowid, id, title, notes)
        VALUES (new.rowid, new.id, new.title, new.notes);
      END;

      CREATE TRIGGER tasks_search_delete AFTER DELETE ON tasks BEGIN
        INSERT INTO task_search(task_search, rowid, id, title, notes)
        VALUES ('delete', old.rowid, old.id, old.title, old.notes);
      END;

      CREATE TRIGGER tasks_search_update AFTER UPDATE OF title, notes ON tasks BEGIN
        INSERT INTO task_search(task_search, rowid, id, title, notes)
        VALUES ('delete', old.rowid, old.id, old.title, old.notes);
        INSERT INTO task_search(rowid, id, title, notes)
        VALUES (new.rowid, new.id, new.title, new.notes);
      END;
    `
  },
  {
    id: 2,
    name: 'research_workbench_schema',
    sql: `
      CREATE TABLE papers (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json)),
        year INTEGER CHECK (year IS NULL OR (year >= 0 AND year <= 9999)),
        venue TEXT NOT NULL DEFAULT '',
        abstract TEXT NOT NULL DEFAULT '',
        doi TEXT,
        url TEXT,
        citation_key TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
        collections_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(collections_json)),
        status TEXT NOT NULL DEFAULT 'inbox'
          CHECK (status IN ('inbox', 'queued', 'reading', 'read', 'archived')),
        rating INTEGER NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
        local_pdf_path TEXT,
        source TEXT NOT NULL DEFAULT 'manual'
          CHECK (source IN ('manual', 'zotero', 'notion', 'obsidian', 'import')),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      CREATE INDEX papers_project_status_updated_idx
        ON papers(project_id, status, updated_at);
      CREATE INDEX papers_archived_at_idx ON papers(archived_at);
      CREATE INDEX papers_doi_idx ON papers(doi);
      CREATE INDEX papers_citation_key_idx ON papers(citation_key);

      CREATE TABLE literature_matrix_entries (
        id TEXT PRIMARY KEY NOT NULL,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        research_question TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '',
        key_findings TEXT NOT NULL DEFAULT '',
        limitations TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        relevance TEXT NOT NULL DEFAULT '',
        quality_score INTEGER NOT NULL DEFAULT 0
          CHECK (quality_score >= 0 AND quality_score <= 100),
        custom_fields_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(custom_fields_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        UNIQUE(paper_id)
      ) STRICT;

      CREATE INDEX literature_matrix_entries_updated_idx
        ON literature_matrix_entries(updated_at);

      CREATE TABLE research_artifacts (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'daily_digest', 'paper_summary', 'literature_review', 'research_idea',
          'research_plan', 'outline', 'manuscript'
        )),
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        source_paper_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(source_paper_ids_json)),
        citations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'review', 'final', 'archived')),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      CREATE INDEX research_artifacts_project_kind_updated_idx
        ON research_artifacts(project_id, kind, updated_at);
      CREATE INDEX research_artifacts_archived_at_idx
        ON research_artifacts(archived_at);

      CREATE TABLE integration_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('obsidian', 'zotero', 'notion')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        location TEXT NOT NULL DEFAULT '',
        settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
        credential_present INTEGER NOT NULL DEFAULT 0
          CHECK (credential_present IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN (
          'not_configured', 'ready', 'syncing', 'error', 'disabled'
        )),
        last_sync_at TEXT,
        last_error TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      CREATE INDEX integration_profiles_provider_idx ON integration_profiles(provider);
      CREATE INDEX integration_profiles_archived_at_idx ON integration_profiles(archived_at);

      CREATE TABLE external_links (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL REFERENCES integration_profiles(id) ON DELETE RESTRICT,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('project', 'task', 'paper', 'artifact')),
        entity_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        locator TEXT NOT NULL DEFAULT '',
        managed_block_id TEXT,
        remote_revision TEXT,
        sync_state TEXT NOT NULL CHECK (sync_state IN (
          'synced', 'local_changed', 'remote_changed', 'conflict', 'deleted'
        )),
        last_synced_at TEXT,
        UNIQUE(profile_id, entity_kind, external_id)
      ) STRICT;

      CREATE INDEX external_links_profile_state_idx
        ON external_links(profile_id, sync_state);
      CREATE INDEX external_links_entity_idx
        ON external_links(entity_kind, entity_id);

      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL REFERENCES integration_profiles(id) ON DELETE RESTRICT,
        direction TEXT NOT NULL CHECK (direction IN ('pull', 'push', 'both')),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'running', 'completed', 'failed', 'canceled'
        )),
        pulled INTEGER NOT NULL DEFAULT 0 CHECK (pulled >= 0),
        pushed INTEGER NOT NULL DEFAULT 0 CHECK (pushed >= 0),
        conflicts INTEGER NOT NULL DEFAULT 0 CHECK (conflicts >= 0),
        message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;

      CREATE INDEX sync_runs_profile_started_idx ON sync_runs(profile_id, started_at);

      CREATE TABLE prompt_templates (
        id TEXT PRIMARY KEY NOT NULL,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        user_template TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      INSERT INTO prompt_templates (
        id, key, name, description, system_prompt, user_template,
        version, built_in, created_at, updated_at, revision
      ) VALUES
        (
          'builtin.prompt.daily-reading', 'daily-reading', '每日文献精读',
          '生成带来源边界的每日精读卡片。',
          '你是严谨的科研阅读助手。只根据输入材料作答，区分事实、作者主张与推断，缺少证据时明确说明。',
          '请精读以下文献并输出研究问题、方法、数据、关键结论、局限、可复现要点与三个延伸问题：{{paper}}',
          1, 1, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0
        ),
        (
          'builtin.prompt.matrix-extraction', 'matrix-extraction', '文献矩阵提取',
          '将文献证据提取到标准矩阵字段。',
          '你是文献证据抽取助手。不得臆测空缺字段，每个结论都要能追溯到输入。',
          '从以下文献中提取研究问题、方法、数据、关键发现、局限、证据、相关性和质量评分：{{paper}}',
          1, 1, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0
        ),
        (
          'builtin.prompt.review-outline', 'review-outline', '综述大纲',
          '从文献矩阵生成可验证的综述结构。',
          '你是学术综述规划助手。以证据覆盖度组织章节，并标出争议、空白和不可支持的论点。',
          '基于以下矩阵生成综述大纲、章节论点、证据映射与研究空白：{{matrix}}',
          1, 1, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0
        ),
        (
          'builtin.prompt.review-draft', 'review-draft', '文献综述草稿',
          '依据已核验矩阵和大纲起草综述。',
          '你是学术写作助手。保持引用占位符，不创造来源，不把相关性写成因果性。',
          '依据大纲 {{outline}} 与证据矩阵 {{matrix}} 起草综述，并单列证据不足段落。',
          1, 1, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0
        ),
        (
          'builtin.prompt.research-idea', 'research-idea', 'AI4S 科研思路',
          '从证据与约束中生成可证伪的科研思路。',
          '你是 AI4Science 研究设计助手。优先提出可证伪、可复现且资源约束明确的思路。',
          '基于研究背景 {{context}}、已有证据 {{evidence}} 与约束 {{constraints}} 生成候选问题、创新点、风险和验证路径。',
          1, 1, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0
        ),
        (
          'builtin.prompt.research-plan', 'research-plan', '科研方案制定',
          '将研究思路转化为阶段化执行方案。',
          '你是科研方案规划助手。给出假设、变量、对照、里程碑、停止条件、风险和替代路线。',
          '把以下研究思路转化为可执行方案，并标注每一步的输入、输出、验证标准与时间预算：{{idea}}',
          1, 1, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0
        ),
        (
          'builtin.prompt.writing-revision', 'writing-revision', '论文写作修订',
          '在不改变证据含义的前提下修订论文文字。',
          '你是科研论文写作助手。保留技术含义与引用边界，区分语言改写和实质性主张修改。',
          '按目标 {{goal}} 修订以下文本，并列出主张变化、仍需证据处与术语一致性问题：{{draft}}',
          1, 1, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0
        );

      CREATE TABLE ai_provider_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN (
          'mock', 'openai', 'anthropic', 'deepseek', 'xai', 'gemini', 'ollama', 'custom'
        )),
        api TEXT NOT NULL CHECK (api IN (
          'mock', 'openai-responses', 'openai-completions',
          'anthropic-messages', 'google-generative-ai'
        )),
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        credential_present INTEGER NOT NULL DEFAULT 0
          CHECK (credential_present IN (0, 1)),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      CREATE INDEX ai_provider_profiles_provider_idx ON ai_provider_profiles(provider);
      CREATE INDEX ai_provider_profiles_archived_at_idx ON ai_provider_profiles(archived_at);

      INSERT INTO ai_provider_profiles (
        id, provider, api, name, model, base_url, enabled, credential_present,
        archived_at, created_at, updated_at, revision
      ) VALUES (
        'builtin.provider.mock', 'mock', 'mock', 'Mock（确定性）', 'deterministic', '', 1, 0,
        NULL, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', 0
      );

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY NOT NULL,
        workflow_key TEXT NOT NULL CHECK (workflow_key IN (
          'daily_digest', 'paper_summary', 'literature_matrix', 'literature_review',
          'research_ideation', 'research_plan', 'manuscript_draft'
        )),
        provider_profile_id TEXT REFERENCES ai_provider_profiles(id) ON DELETE SET NULL,
        prompt_template_id TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        paper_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(paper_ids_json)),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
        input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
        output TEXT NOT NULL DEFAULT '',
        citations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      ) STRICT;

      CREATE INDEX agent_runs_created_idx ON agent_runs(created_at);
      CREATE INDEX agent_runs_status_created_idx ON agent_runs(status, created_at);

      CREATE TABLE schedules (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        workflow_key TEXT NOT NULL CHECK (workflow_key IN (
          'daily_digest', 'paper_summary', 'literature_matrix', 'literature_review',
          'research_ideation', 'research_plan', 'manuscript_draft'
        )),
        prompt_template_id TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
        provider_profile_id TEXT REFERENCES ai_provider_profiles(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        missed_policy TEXT NOT NULL DEFAULT 'coalesce_one'
          CHECK (missed_policy = 'coalesce_one'),
        next_run_at TEXT,
        last_run_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      CREATE INDEX schedules_enabled_next_run_idx ON schedules(enabled, next_run_at);
      CREATE INDEX schedules_archived_at_idx ON schedules(archived_at);
    `
  },
  {
    id: 3,
    name: 'evidence_prompt_workflows',
    sql: `
      UPDATE prompt_templates
      SET
        description = '按主题发现或精读文献，生成带来源边界的每日卡片。',
        user_template = '主题：{{topic}}\n本次要求：{{instructions}}\n优先精读以下已选文献：{{paper}}\n如果没有已选文献且可使用联网搜索，请检索主题相关的近期论文，列出可核验 URL，再输出研究问题、方法、数据、关键结论、局限、可复现要点与三个延伸问题。',
        version = 2,
        updated_at = '2026-08-24T05:35:00.000Z',
        revision = revision + 1
      WHERE id = 'builtin.prompt.daily-reading'
        AND built_in = 1
        AND version = 1
        AND revision = 0;

      INSERT INTO prompt_templates (
        id, key, name, description, system_prompt, user_template,
        version, built_in, created_at, updated_at, revision
      )
      SELECT
        'builtin.prompt.paper-summary', 'paper-summary', '文献汇总',
        '对一篇或多篇已选文献生成可追溯的结构化汇总。',
        '你是严谨的科研阅读助手。只使用输入证据；逐篇区分事实、作者主张和你的推断，不创造引用。',
        '本次要求：{{instructions}}\n请汇总以下文献，逐篇给出问题、方法、数据、核心发现、局限与可复现线索，最后比较共识和分歧：{{paper}}',
        1, 1, '2026-08-24T05:35:00.000Z', '2026-08-24T05:35:00.000Z', 0
      WHERE NOT EXISTS (
        SELECT 1 FROM prompt_templates WHERE id = 'builtin.prompt.paper-summary'
      );
    `
  },
  {
    id: 4,
    name: 'workspace_v2_foundation',
    sql: `
      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK (type IN (
          'event', 'milestone', 'reading', 'experiment', 'meeting', 'submission', 'deadline'
        )),
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        CHECK (ends_at >= starts_at)
      ) STRICT;

      CREATE INDEX calendar_events_range_idx ON calendar_events(starts_at, ends_at);
      CREATE INDEX calendar_events_project_idx ON calendar_events(project_id);

      CREATE TABLE resource_links (
        id TEXT PRIMARY KEY NOT NULL,
        from_kind TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relationship TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL CHECK (created_by IN ('user', 'mcp', 'scheduler', 'agent')),
        UNIQUE(from_kind, from_id, to_kind, to_id, relationship)
      ) STRICT;

      CREATE INDEX resource_links_from_idx ON resource_links(from_kind, from_id);
      CREATE INDEX resource_links_to_idx ON resource_links(to_kind, to_id);

      CREATE TABLE workspace_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      CREATE TABLE search_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        query TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN (
          'local', 'crossref', 'openalex', 'pubmed', 'arxiv', 'semantic_scholar', 'google_scholar'
        )),
        filters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters_json)),
        created_at TEXT NOT NULL,
        result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0)
      ) STRICT;

      CREATE INDEX search_sessions_created_idx ON search_sessions(created_at);

      CREATE TABLE search_results (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES search_sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        authors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json)),
        year INTEGER,
        venue TEXT NOT NULL DEFAULT '',
        abstract TEXT NOT NULL DEFAULT '',
        doi TEXT,
        url TEXT,
        is_open_access INTEGER CHECK (is_open_access IS NULL OR is_open_access IN (0, 1)),
        fingerprint TEXT NOT NULL,
        dedupe_reason TEXT NOT NULL DEFAULT '',
        dedupe_confidence REAL NOT NULL DEFAULT 0 CHECK (
          dedupe_confidence >= 0 AND dedupe_confidence <= 1
        ),
        UNIQUE(session_id, source, source_id)
      ) STRICT;

      CREATE INDEX search_results_session_idx ON search_results(session_id);
      CREATE INDEX search_results_fingerprint_idx ON search_results(fingerprint);

      CREATE TABLE note_index (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL REFERENCES integration_profiles(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        title TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
        updated_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        UNIQUE(profile_id, relative_path)
      ) STRICT;

      CREATE INDEX note_index_profile_updated_idx ON note_index(profile_id, updated_at);

      CREATE TABLE workspace_audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('user', 'mcp', 'scheduler', 'agent')),
        action TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT,
        risk TEXT NOT NULL CHECK (risk IN ('read', 'write', 'sensitive')),
        outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX workspace_audit_created_idx ON workspace_audit_events(created_at);
    `
  },
  {
    id: 5,
    name: 'task_archive_and_resource_audit',
    disableForeignKeys: true,
    sql: `
      /* SQLite cannot alter a CHECK constraint in place. Rebuild tasks while
       * preserving rowids so the content FTS table remains deterministic. */
      DROP TRIGGER IF EXISTS tasks_search_insert;
      DROP TRIGGER IF EXISTS tasks_search_delete;
      DROP TRIGGER IF EXISTS tasks_search_update;
      DROP TABLE IF EXISTS task_search;

      CREATE TABLE tasks_v5 (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        column_id TEXT REFERENCES board_columns(id) ON DELETE SET NULL,
        parent_task_id TEXT REFERENCES tasks_v5(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'inbox'
          CHECK (status IN ('inbox', 'planned', 'in_progress', 'blocked', 'done', 'canceled', 'archived')),
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes > 0),
        start_at TEXT,
        due_at TEXT,
        completed_at TEXT,
        sort_key REAL NOT NULL,
        archived_at TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        CHECK (
          (project_id IS NULL AND column_id IS NULL AND status IN ('inbox', 'canceled', 'archived'))
          OR project_id IS NOT NULL
        ),
        CHECK (status <> 'archived' OR (archived_at IS NOT NULL AND column_id IS NULL)),
        CHECK (status = 'archived' OR archived_at IS NULL)
      ) STRICT;

      INSERT INTO tasks_v5 (
        rowid, id, project_id, column_id, parent_task_id, title, notes, status,
        priority, estimate_minutes, start_at, due_at, completed_at, sort_key,
        archived_at, tags_json, created_at, updated_at, revision
      )
      SELECT
        rowid, id, project_id,
        CASE WHEN archived_at IS NOT NULL THEN NULL ELSE column_id END,
        parent_task_id, title, notes,
        CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE status END,
        priority, estimate_minutes, start_at, due_at, completed_at, sort_key,
        archived_at, '[]', created_at, updated_at, revision
      FROM tasks;

      INSERT INTO workspace_audit_events (
        id, actor, action, resource_kind, resource_id, risk, outcome, summary, created_at
      )
      SELECT
        'migration.v5.task_archive_backfill:' || id,
        'agent',
        'migration.v5.task_archive_backfill',
        'task',
        id,
        'write',
        'allowed',
        json_object('previousStatus', status, 'archivedAt', archived_at),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM tasks
      WHERE archived_at IS NOT NULL;

      DROP INDEX IF EXISTS tasks_project_column_sort_idx;
      DROP INDEX IF EXISTS tasks_status_due_at_idx;
      DROP INDEX IF EXISTS tasks_archived_at_idx;
      DROP INDEX IF EXISTS tasks_completed_at_idx;
      DROP TABLE tasks;
      ALTER TABLE tasks_v5 RENAME TO tasks;

      CREATE INDEX tasks_project_column_sort_idx
        ON tasks(project_id, column_id, sort_key);
      CREATE INDEX tasks_status_due_at_idx ON tasks(status, due_at);
      CREATE INDEX tasks_archived_at_idx ON tasks(archived_at);
      CREATE INDEX tasks_completed_at_idx ON tasks(completed_at);
      CREATE INDEX tasks_project_archive_due_idx
        ON tasks(project_id, archived_at, due_at, status);

      CREATE VIRTUAL TABLE task_search USING fts5(
        id UNINDEXED,
        title,
        notes,
        content='tasks',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      INSERT INTO task_search(rowid, id, title, notes)
        SELECT rowid, id, title, notes FROM tasks;

      CREATE TRIGGER tasks_search_insert AFTER INSERT ON tasks BEGIN
        INSERT INTO task_search(rowid, id, title, notes)
        VALUES (new.rowid, new.id, new.title, new.notes);
      END;

      CREATE TRIGGER tasks_search_delete AFTER DELETE ON tasks BEGIN
        INSERT INTO task_search(task_search, rowid, id, title, notes)
        VALUES ('delete', old.rowid, old.id, old.title, old.notes);
      END;

      CREATE TRIGGER tasks_search_update AFTER UPDATE OF title, notes ON tasks BEGIN
        INSERT INTO task_search(task_search, rowid, id, title, notes)
        VALUES ('delete', old.rowid, old.id, old.title, old.notes);
        INSERT INTO task_search(rowid, id, title, notes)
        VALUES (new.rowid, new.id, new.title, new.notes);
      END;

      CREATE TABLE workspace_confirmation_contexts (
        confirmation_id TEXT PRIMARY KEY NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('task.hardDelete', 'tasks.bulkHardDelete')),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX workspace_confirmation_expires_idx
        ON workspace_confirmation_contexts(expires_at);
    `
  },
  {
    id: 6,
    name: 'calendar_markers_and_editable_records',
    sql: `
      CREATE TABLE calendar_markers (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK (type IN ('note', 'reminder', 'milestone', 'daily_push', 'reading', 'deadline')),
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 1 CHECK (all_day IN (0, 1)),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        color TEXT NOT NULL DEFAULT '#3b82f6' CHECK (color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        CHECK (ends_at >= starts_at)
      ) STRICT;

      CREATE INDEX calendar_markers_range_idx ON calendar_markers(starts_at, ends_at);
      CREATE INDEX calendar_markers_project_idx ON calendar_markers(project_id);
    `
  },
  {
    id: 7,
    name: 'search_result_open_metric',
    sql: `
      ALTER TABLE search_results ADD COLUMN open_metric REAL;
    `
  },
  {
    id: 8,
    name: 'all_literature_search_source',
    disableForeignKeys: true,
    sql: `
      CREATE TABLE search_sessions_v8 (
        id TEXT PRIMARY KEY NOT NULL,
        query TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN (
          'all', 'local', 'crossref', 'openalex', 'pubmed', 'arxiv', 'semantic_scholar', 'google_scholar'
        )),
        filters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters_json)),
        created_at TEXT NOT NULL,
        result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0)
      ) STRICT;
      INSERT INTO search_sessions_v8 (id, query, source, filters_json, created_at, result_count)
        SELECT id, query, source, filters_json, created_at, result_count FROM search_sessions;
      DROP TABLE search_sessions;
      ALTER TABLE search_sessions_v8 RENAME TO search_sessions;
      CREATE INDEX search_sessions_created_idx ON search_sessions(created_at);
    `
  },
  {
    id: 9,
    name: 'agent_runtime_foundation',
    sql: `
      ALTER TABLE agent_runs ADD COLUMN job_id TEXT;
      ALTER TABLE agent_runs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'pi' CHECK (runtime IN ('codex', 'pi'));
      ALTER TABLE agent_runs ADD COLUMN transport TEXT NOT NULL DEFAULT 'inprocess' CHECK (transport IN ('cli', 'inprocess'));
      ALTER TABLE agent_runs ADD COLUMN tool_profile TEXT NOT NULL DEFAULT 'read-only' CHECK (tool_profile IN ('read-only', 'approved-write'));
      ALTER TABLE agent_runs ADD COLUMN agent_status TEXT NOT NULL DEFAULT 'queued'
        CHECK (agent_status IN ('planned', 'queued', 'running', 'waiting_confirmation', 'completed', 'partial', 'failed', 'canceled', 'blocked', 'missed'));
      ALTER TABLE agent_runs ADD COLUMN artifact_id TEXT;

      CREATE TABLE agent_connectors (
        id TEXT PRIMARY KEY NOT NULL,
        runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'pi')),
        executable_path TEXT,
        version TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        available INTEGER NOT NULL DEFAULT 0 CHECK (available IN (0, 1)),
        mcp INTEGER NOT NULL DEFAULT 1 CHECK (mcp IN (0, 1)),
        structured_output INTEGER NOT NULL DEFAULT 1 CHECK (structured_output IN (0, 1)),
        workspace_write INTEGER NOT NULL DEFAULT 1 CHECK (workspace_write IN (0, 1)),
        message TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        UNIQUE(runtime)
      ) STRICT;

      CREATE TABLE agent_bindings (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'pi')),
        fallback_runtime TEXT CHECK (fallback_runtime IS NULL OR fallback_runtime IN ('codex', 'pi')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        UNIQUE(project_id)
      ) STRICT;

      CREATE TABLE agent_run_events (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(run_id, seq)
      ) STRICT;
      CREATE INDEX agent_run_events_run_idx ON agent_run_events(run_id, seq);

      CREATE TABLE agent_inbox_items (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        artifact_id TEXT REFERENCES research_artifacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
        archived_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX agent_inbox_created_idx ON agent_inbox_items(created_at);
      CREATE INDEX agent_inbox_read_idx ON agent_inbox_items(read, archived_at);

      INSERT INTO agent_connectors (
        id, runtime, executable_path, version, enabled, available, mcp,
        structured_output, workspace_write, message, updated_at, revision
      ) VALUES
        ('builtin.agent.codex', 'codex', NULL, NULL, 1, 0, 1, 1, 1, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0),
        ('builtin.agent.pi', 'pi', NULL, NULL, 1, 0, 1, 1, 1, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0);
    `
  },
  {
    id: 10,
    name: 'agent_run_idempotency',
    sql: `
      ALTER TABLE agent_runs ADD COLUMN idempotency_key TEXT;
      CREATE UNIQUE INDEX agent_runs_idempotency_idx
        ON agent_runs(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `
  },
  {
    id: 11,
    name: 'agent_run_status_index',
    sql: `
      CREATE INDEX agent_runs_agent_status_created_idx
        ON agent_runs(agent_status, created_at);
    `
  },
  {
    id: 12,
    name: 'agent_aionui_compatibility',
    sql: `
      ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT;

      ALTER TABLE schedules ADD COLUMN runtime TEXT CHECK (runtime IS NULL OR runtime IN ('codex', 'pi'));
      ALTER TABLE schedules ADD COLUMN model TEXT;
      ALTER TABLE schedules ADD COLUMN assistant_key TEXT;
      ALTER TABLE schedules ADD COLUMN workspace_path TEXT;
      ALTER TABLE schedules ADD COLUMN frequency TEXT NOT NULL DEFAULT 'custom'
        CHECK (frequency IN ('manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom'));
      ALTER TABLE schedules ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'new_conversation'
        CHECK (execution_mode IN ('new_conversation', 'existing'));
      ALTER TABLE schedules ADD COLUMN conversation_id TEXT;
      ALTER TABLE schedules ADD COLUMN prompt TEXT NOT NULL DEFAULT '';

      CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'pi' CHECK (runtime IN ('codex', 'pi')),
        model TEXT,
        assistant_key TEXT,
        tool_profile TEXT NOT NULL DEFAULT 'read-only'
          CHECK (tool_profile IN ('read-only', 'approved-write')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'finished', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;
      CREATE INDEX agent_conversations_project_updated_idx
        ON agent_conversations(project_id, updated_at);
      CREATE INDEX agent_conversations_archived_idx
        ON agent_conversations(archived_at);

      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq >= 0)
      ) STRICT;
      CREATE UNIQUE INDEX agent_messages_conversation_seq_idx
        ON agent_messages(conversation_id, seq);
      CREATE INDEX agent_messages_conversation_created_idx
        ON agent_messages(conversation_id, created_at);
    `
  },
  {
    id: 13,
    name: 'agent_runtime_proxy_config',
    sql: `
      ALTER TABLE agent_connectors ADD COLUMN proxy_enabled INTEGER NOT NULL DEFAULT 0 CHECK (proxy_enabled IN (0, 1));
      ALTER TABLE agent_connectors ADD COLUMN http_proxy TEXT;
      ALTER TABLE agent_connectors ADD COLUMN https_proxy TEXT;
      ALTER TABLE agent_connectors ADD COLUMN no_proxy TEXT;
    `
  },
  {
    id: 14,
    name: 'literature_staging_records',
    sql: `
      CREATE TABLE literature_staging (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT REFERENCES search_sessions(id) ON DELETE SET NULL,
        source TEXT NOT NULL CHECK (source IN (
          'local', 'crossref', 'openalex', 'pubmed', 'arxiv',
          'semantic_scholar', 'google_scholar'
        )),
        source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        authors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json)),
        year INTEGER CHECK (year IS NULL OR year >= 0),
        venue TEXT NOT NULL DEFAULT '',
        abstract TEXT NOT NULL DEFAULT '',
        doi TEXT,
        url TEXT,
        is_open_access INTEGER CHECK (is_open_access IS NULL OR is_open_access IN (0, 1)),
        open_metric REAL CHECK (open_metric IS NULL OR open_metric >= 0),
        fingerprint TEXT NOT NULL CHECK (length(trim(fingerprint)) > 0),
        dedupe_reason TEXT NOT NULL DEFAULT '',
        dedupe_confidence REAL NOT NULL DEFAULT 0 CHECK (dedupe_confidence >= 0 AND dedupe_confidence <= 1),
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        UNIQUE(source, source_id)
      ) STRICT;

      CREATE INDEX literature_staging_session_idx ON literature_staging(session_id);
      CREATE INDEX literature_staging_project_idx ON literature_staging(project_id);
      CREATE INDEX literature_staging_updated_idx ON literature_staging(updated_at);
    `
  },
  {
    id: 15,
    name: 'agent_cli_permission_and_last30days_schedule',
    sql: `
      ALTER TABLE agent_runs ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read-only'
        CHECK (permission_mode IN ('read-only', 'auto', 'full-access'));
      ALTER TABLE agent_runs ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'on-request'
        CHECK (approval_policy IN ('on-request', 'never'));
      ALTER TABLE agent_conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read-only'
        CHECK (permission_mode IN ('read-only', 'auto', 'full-access'));
      ALTER TABLE agent_conversations ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'on-request'
        CHECK (approval_policy IN ('on-request', 'never'));
      ALTER TABLE schedules ADD COLUMN skill_key TEXT;
      ALTER TABLE schedules ADD COLUMN topic TEXT NOT NULL DEFAULT '';
      ALTER TABLE schedules ADD COLUMN output_folder TEXT NOT NULL DEFAULT '每日文献推送';
      ALTER TABLE schedules ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read-only'
        CHECK (permission_mode IN ('read-only', 'auto', 'full-access'));
      ALTER TABLE schedules ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'on-request'
        CHECK (approval_policy IN ('on-request', 'never'));
      INSERT OR IGNORE INTO schedules (
        id, name, workflow_key, prompt_template_id, provider_profile_id,
        project_id, cron, timezone, enabled, missed_policy, next_run_at,
        last_run_at, archived_at, created_at, updated_at, revision,
        skill_key, topic, output_folder, permission_mode, approval_policy,
        runtime, assistant_key, frequency
      ) VALUES (
        'builtin.schedule.last30days', 'Last 30 days 每日资讯推送', 'daily_digest',
        'builtin.prompt.daily-reading', NULL, NULL, '0 9 * * *', 'Asia/Shanghai',
        1, 'coalesce_one', NULL, NULL, NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0,
        'last30days', 'research updates', '每日资讯推送', 'read-only', 'on-request',
        'codex', 'researcher', 'daily'
      );
    `
  },
  {
    id: 16,
    name: 'enable_builtin_last30days_schedule_once',
    sql: `
      UPDATE schedules
      SET topic = CASE WHEN trim(topic) = '' THEN 'research updates' ELSE topic END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'builtin.schedule.last30days' AND archived_at IS NULL;
    `
  },
  {
    id: 17,
    name: 'knowledge_engine_connections',
    sql: `
      CREATE TABLE workspace_knowledge_engines (
        kind TEXT PRIMARY KEY NOT NULL CHECK (kind IN ('anythingllm', 'llmwiki')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        base_url TEXT NOT NULL DEFAULT '',
        workspace TEXT NOT NULL DEFAULT '',
        collection TEXT NOT NULL DEFAULT '',
        credential_present INTEGER NOT NULL DEFAULT 0 CHECK (credential_present IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'not_configured'
          CHECK (status IN ('connected', 'disconnected', 'not_configured', 'error')),
        last_checked_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;
    `
  },
  {
    id: 18,
    name: 'normalize_builtin_last30days_schedule',
    sql: `
      UPDATE schedules
      SET frequency = 'daily',
          runtime = COALESCE(runtime, 'codex'),
          assistant_key = COALESCE(NULLIF(trim(assistant_key), ''), 'researcher'),
          cron = '0 9 * * *',
          timezone = COALESCE(NULLIF(trim(timezone), ''), 'Asia/Shanghai'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'builtin.schedule.last30days' AND archived_at IS NULL;
    `
  },
  {
    id: 19,
    name: 'repair_builtin_last30days_state_and_history',
    sql: `
      -- Early Agent builds could claim the same stale cron cursor on every
      -- scheduler tick.  Preserve those runs/messages for audit, but archive
      -- only conversations that are provably owned by the built-in schedule
      -- so they no longer flood the normal conversation list.  User-created
      -- conversations, including ones with the same title, are untouched.
      UPDATE agent_conversations
      SET status = 'archived',
          archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          revision = revision + 1
      WHERE archived_at IS NULL
        AND id IN (
          SELECT DISTINCT conversation_id
          FROM agent_runs
          WHERE job_id = 'builtin.schedule.last30days'
            AND conversation_id IS NOT NULL
        );

      -- This one-time upgrade restores the product default requested for the
      -- built-in job.  Clearing the cursor is deliberate: the first scheduler
      -- tick seeds the next future 09:00 occurrence instead of replaying an
      -- old occurrence immediately.  Subsequent user pause/enable choices are
      -- retained because this migration runs exactly once.
      --
      -- It is gated on revision = 0 so that a user who had already paused
      -- the built-in rule on an older install is never silently re-enabled by
      -- an upgrade: any user save bumps revision (saveSchedule + the timing
      -- update), while a row still at revision 0 has never been touched by the
      -- user, so only that row may receive the product default.
      UPDATE schedules
      SET enabled = 1,
          next_run_at = NULL,
          frequency = 'daily',
          runtime = COALESCE(runtime, 'codex'),
          assistant_key = COALESCE(NULLIF(trim(assistant_key), ''), 'researcher'),
          cron = '0 9 * * *',
          timezone = 'Asia/Shanghai',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          revision = revision + 1
      WHERE id = 'builtin.schedule.last30days' AND archived_at IS NULL AND revision = 0;
    `
  },
  {
    id: 20,
    name: 'agent_proxy_profiles_and_bindings',
    sql: `
      CREATE TABLE agent_proxy_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        http_proxy TEXT,
        https_proxy TEXT,
        no_proxy TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;
      CREATE TABLE agent_proxy_bindings (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL REFERENCES agent_proxy_profiles(id) ON DELETE CASCADE,
        runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'pi')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        UNIQUE(runtime)
      ) STRICT;
      CREATE INDEX agent_proxy_bindings_profile_idx ON agent_proxy_bindings(profile_id);
    `
  },
  {
    id: 21,
    name: 'search_result_impact_factor_fields',
    sql: `
      ALTER TABLE search_results ADD COLUMN impact_factor REAL;
      ALTER TABLE search_results ADD COLUMN impact_factor_source TEXT;
      ALTER TABLE search_results ADD COLUMN impact_factor_fetched_at TEXT;
    `
  },
  {
    id: 22,
    name: 'agent_run_records',
    sql: `
      CREATE TABLE agent_run_records (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        record_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'user', 'assistant', 'reasoning', 'tool', 'subtool', 'system', 'context',
          'diagnostic', 'compacted', 'error', 'turn_end'
        )),
        status TEXT NOT NULL DEFAULT 'info' CHECK (status IN ('info', 'running', 'completed', 'failed', 'canceled')),
        turn INTEGER NOT NULL DEFAULT 0 CHECK (turn >= 0),
        step INTEGER NOT NULL DEFAULT 0 CHECK (step >= 0),
        title TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        input_text TEXT,
        output_text TEXT,
        tool_name TEXT,
        call_id TEXT,
        parent_id TEXT,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(run_id, seq),
        UNIQUE(run_id, record_key)
      ) STRICT;
      CREATE INDEX agent_run_records_run_created_idx ON agent_run_records(run_id, created_at);
      CREATE INDEX agent_runs_conversation_created_idx ON agent_runs(conversation_id, created_at);

      /* One-time replay of already persisted history into the normalized ledger.
         Rows come from three additive sources and are ordered inside each run:
         user message (0) -> raw run events (1) -> assistant message (2, only for
         runs that never recorded an assistant_message event). The raw event
         payload stays available as output_text so nothing detected here is lost,
         and no existing table is rewritten. */
      INSERT INTO agent_run_records (
        id, run_id, seq, record_key, kind, status, turn, step, title, detail,
        input_text, output_text, tool_name, call_id, parent_id,
        started_at, finished_at, duration_ms, usage_json, truncated, created_at
      )
      SELECT
        'legacy:' || source.origin_id,
        source.run_id,
        ROW_NUMBER() OVER (PARTITION BY source.run_id ORDER BY source.ord, source.source_seq) - 1,
        'legacy:' || source.origin_id,
        source.kind,
        source.status,
        0,
        0,
        source.title,
        source.detail,
        NULL,
        source.output_text,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        CASE WHEN source.unclipped_length > 65536 THEN 1 ELSE 0 END,
        source.created_at
      FROM (
        SELECT
          m.id AS origin_id,
          m.run_id AS run_id,
          0 AS ord,
          m.seq AS source_seq,
          'user' AS kind,
          'info' AS status,
          '你' AS title,
          substr(m.content, 1, 65536) AS detail,
          NULL AS output_text,
          length(m.content) AS unclipped_length,
          m.created_at AS created_at
        FROM agent_messages m
        WHERE m.run_id IS NOT NULL AND m.role = 'user'

        UNION ALL

        SELECT
          e.id,
          e.run_id,
          1,
          e.seq,
          CASE e.kind
            WHEN 'assistant_message' THEN 'assistant'
            WHEN 'tool_call' THEN 'tool'
            WHEN 'failed' THEN 'error'
            WHEN 'canceled' THEN 'error'
            WHEN 'completed' THEN 'turn_end'
            WHEN 'started' THEN 'system'
            ELSE 'context'
          END,
          CASE e.kind
            WHEN 'assistant_message' THEN 'completed'
            WHEN 'failed' THEN 'failed'
            WHEN 'canceled' THEN 'canceled'
            WHEN 'completed' THEN 'completed'
            ELSE 'info'
          END,
          CASE e.kind
            WHEN 'assistant_message' THEN '历史消息'
            WHEN 'tool_call' THEN '历史工具调用'
            ELSE '事件 ' || e.kind
          END,
          COALESCE(substr(CASE WHEN json_valid(e.payload_json) THEN COALESCE(
            json_extract(e.payload_json, '$.text'),
            json_extract(e.payload_json, '$.message'),
            json_extract(e.payload_json, '$.delta'),
            json_extract(e.payload_json, '$.output'),
            json_extract(e.payload_json, '$.content'),
            json_extract(e.payload_json, '$.item.text'),
            json_extract(e.payload_json, '$.assistantMessageEvent.delta'),
            json_extract(e.payload_json, '$')
          ) END, 1, 65536), ''),
          substr(e.payload_json, 1, 65536),
          length(e.payload_json),
          e.created_at
        FROM agent_run_events e

        UNION ALL

        SELECT
          m.id,
          m.run_id,
          2,
          m.seq,
          'assistant',
          'completed',
          '历史回复',
          substr(m.content, 1, 65536),
          NULL,
          length(m.content),
          m.created_at
        FROM agent_messages m
        WHERE m.run_id IS NOT NULL
          AND m.role = 'assistant'
          AND NOT EXISTS (
            SELECT 1 FROM agent_run_events e
            WHERE e.run_id = m.run_id AND e.kind = 'assistant_message'
          )
      ) AS source;
    `
  },
  {
    id: 23,
    name: 'daily_literature_push_closure',
    sql: `
      -- Rule fields the daily last30days push needs in order to be reproducible:
      -- which sources were requested and how far back the run may look.  An
      -- empty source list keeps the previous "all available sources" behavior.
      ALTER TABLE schedules ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(sources_json));
      ALTER TABLE schedules ADD COLUMN lookback_days INTEGER NOT NULL DEFAULT 30
        CHECK (lookback_days BETWEEN 1 AND 365);

      -- Directory naming had drifted: the built-in schedule (and any schedule
      -- saved by an older renderer default) wrote to 每日资讯推送 while the
      -- contracts, the Obsidian layout and the safe-write default all used
      -- 每日文献推送.  Earlier migrations keep their historical text; this one
      -- is the single normalization point for already-installed databases so a
      -- Vault can no longer end up with two competing "daily push" folders.
      UPDATE schedules
      SET output_folder = '每日文献推送',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE output_folder = '每日资讯推送';

      UPDATE schedules
      SET name = 'Last 30 days 每日文献推送',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'builtin.schedule.last30days'
        AND name = 'Last 30 days 每日资讯推送';
    `
  },
  {
    id: 24,
    name: 'agent_skill_snapshot_credentials_and_approvals',
    sql: `
      -- A run records the skill it actually resolved, so a retry reproduces the
      -- pinned selection instead of re-resolving whatever is installed later.
      -- The snapshot stores redaction-safe labels only.
      ALTER TABLE agent_runs ADD COLUMN skill_key TEXT;
      ALTER TABLE agent_runs ADD COLUMN skill_snapshot_json TEXT;

      -- Where the runtime credential for this run came from. Runtime secrets
      -- stay in Electron Main's safeStorage vault and are never stored here;
      -- 'none' means the run was started with no app-owned credential at all,
      -- which is a real state the run ledger has to be able to show.
      ALTER TABLE agent_runs ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'none'
        CHECK (credential_source IN ('app-safeStorage', 'none'));

      -- Approval audit rows. Both supported CLIs execute as non-interactive
      -- batch processes, so 'on-request' can never prompt: the coordinator
      -- records what the transport actually did (auto-approved / denied)
      -- instead of pretending an interactive approval queue exists.
      CREATE TABLE agent_approvals (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending', 'auto-approved', 'denied', 'approved', 'rejected', 'expired')),
        policy TEXT NOT NULL DEFAULT 'on-request' CHECK (policy IN ('on-request', 'never')),
        reason TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX agent_approvals_run_created_idx ON agent_approvals(run_id, created_at);
      CREATE INDEX agent_approvals_status_created_idx ON agent_approvals(status, created_at);
    `
  },
  {
    id: 25,
    name: 'schedule_occurrence_ledger',
    sql: `
      -- One row per claimed cron time slot.  The scheduler writes the claim and
      -- advances schedules.next_run_at inside a single transaction, so "the
      -- cursor moved but nothing ran" (crash, forced shutdown) is a durable,
      -- visible occurrence instead of a silently skipped day.  The unique
      -- idempotency key is the run's own key, which collapses a duplicate
      -- 30-second tick, a duplicate manual trigger and the once-per-start
      -- catch-up onto one row.  No schedule flag is modified here: a user
      -- pause stays a pause.
      CREATE TABLE schedule_occurrences (
        id TEXT PRIMARY KEY NOT NULL,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        occurrence_at TEXT NOT NULL,
        local_date_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('scheduler', 'catchup', 'manual')),
        status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'completed', 'failed', 'blocked', 'canceled', 'missed', 'skipped')),
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        reason TEXT NOT NULL DEFAULT '',
        claimed_at TEXT NOT NULL,
        settled_at TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      ) STRICT;

      CREATE INDEX schedule_occurrences_schedule_idx ON schedule_occurrences(schedule_id, occurrence_at);
      CREATE INDEX schedule_occurrences_status_idx ON schedule_occurrences(status, claimed_at);
    `
  },
  {
    id: 26,
    name: 'generic_skill_schedule_contract',
    sql: `
      -- The generic schedule contract adds an explicit output language.  The
      -- default is the frozen product default (Simplified Chinese narrative,
      -- evidence left verbatim), so every already-installed rule keeps its
      -- behavior without a user action.
      ALTER TABLE schedules ADD COLUMN response_language TEXT NOT NULL DEFAULT 'zh-CN'
        CHECK (response_language IN ('zh-CN', 'en'));

      -- The shipped daily-push default moved from skill "last30days" with
      -- topic "research updates" into 每日文献推送 to topic "AI 最新资讯" into
      -- 每日资讯推送.  Only a row that still holds that exact triple is the
      -- *unmodified* old default; this migration normalizes exactly those rows
      -- and leaves every user-edited rule (custom topic, custom folder, other
      -- skill or no skill at all) untouched, including its history.
      UPDATE schedules
      SET topic = 'AI 最新资讯',
          output_folder = '每日资讯推送',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE skill_key = 'last30days'
        AND trim(topic) = 'research updates'
        AND output_folder = '每日文献推送';

      -- The built-in rule is the shipped default itself, so its display name
      -- follows the same rename (migration 23 renamed it the other way for the
      -- same reason).  A user-renamed rule keeps its name.
      UPDATE schedules
      SET name = 'Last 30 days 每日资讯推送',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'builtin.schedule.last30days'
        AND name = 'Last 30 days 每日文献推送';
    `
  },
  {
    id: 27,
    name: 'sync_run_archive_and_revision',
    sql: `
      -- Settings → 最近同步 gets the same delete contract as every other
      -- multi-select list: a CAS lock and a soft archive. Existing rows keep
      -- their audit value (revision 0) and stay visible until the user removes
      -- them; nothing is dropped here and no sync data is deleted.
      ALTER TABLE sync_runs ADD COLUMN archived_at TEXT;
      ALTER TABLE sync_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
    `
  },
  {
    id: 28,
    name: 'three_builtin_schedule_rules',
    sql: `
      -- The shipped schedule surface is exactly three enabled rules: the
      -- last30days news push plus the two project-owned instruction skills
      -- (literature-matrix / literature-review-push). A fresh install already
      -- received the first rule from migration 15 (then normalized by
      -- 16/18/19/23/26); this migration adds the two missing rules and
      -- re-asserts the daily push row for a database where it is gone.
      --
      -- Every statement is INSERT OR IGNORE, i.e. write-only-when-absent:
      -- an existing rule (renamed, re-foldered, retopiced, paused or archived
      -- by the user) keeps every stored value, its revision and its schedule
      -- cursor. Nothing here ever UPDATEs a rule, so an upgrade can neither
      -- re-enable a pause nor resurrect an archived rule. The literals match
      -- DEFAULT_AGENT_SCHEDULE_RULES in @prw/contracts; the focused
      -- default-schedules test fails if the two drift apart.
      INSERT OR IGNORE INTO schedules (
        id, name, workflow_key, prompt_template_id, provider_profile_id,
        project_id, cron, timezone, enabled, missed_policy, next_run_at,
        last_run_at, archived_at, created_at, updated_at, revision,
        skill_key, topic, sources_json, lookback_days, response_language,
        output_folder, permission_mode, approval_policy,
        runtime, assistant_key, frequency
      ) VALUES (
        'builtin.schedule.last30days', 'Last 30 days 每日资讯推送', 'daily_digest',
        'builtin.prompt.daily-reading', NULL, NULL, '0 9 * * *', 'Asia/Shanghai',
        1, 'coalesce_one', NULL, NULL, NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0,
        'last30days', 'AI 最新资讯', '[]', 30, 'zh-CN',
        '每日资讯推送', 'read-only', 'on-request',
        'codex', 'researcher', 'daily'
      );
      INSERT OR IGNORE INTO schedules (
        id, name, workflow_key, prompt_template_id, provider_profile_id,
        project_id, cron, timezone, enabled, missed_policy, next_run_at,
        last_run_at, archived_at, created_at, updated_at, revision,
        skill_key, topic, sources_json, lookback_days, response_language,
        output_folder, permission_mode, approval_policy,
        runtime, assistant_key, frequency
      ) VALUES (
        'builtin.schedule.literature-matrix', '文献矩阵推送', 'literature_matrix',
        'builtin.prompt.matrix-extraction', NULL, NULL, '0 9 * * *', 'Asia/Shanghai',
        1, 'coalesce_one', NULL, NULL, NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0,
        'literature-matrix', '长上下文检索', '[]', 30, 'zh-CN',
        '文献矩阵', 'read-only', 'on-request',
        'codex', 'researcher', 'daily'
      );
      INSERT OR IGNORE INTO schedules (
        id, name, workflow_key, prompt_template_id, provider_profile_id,
        project_id, cron, timezone, enabled, missed_policy, next_run_at,
        last_run_at, archived_at, created_at, updated_at, revision,
        skill_key, topic, sources_json, lookback_days, response_language,
        output_folder, permission_mode, approval_policy,
        runtime, assistant_key, frequency
      ) VALUES (
        'builtin.schedule.literature-review-push', '文献综述推送', 'literature_review',
        'builtin.prompt.review-outline', NULL, NULL, '0 9 * * *', 'Asia/Shanghai',
        1, 'coalesce_one', NULL, NULL, NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0,
        'literature-review-push', '长上下文检索', '[]', 30, 'zh-CN',
        '文献综述', 'read-only', 'on-request',
        'codex', 'researcher', 'daily'
      );
    `
  },
  {
    id: 29,
    name: 'automation_run_history_archive_and_revision',
    sql: `
      -- The Automation page's RUN HISTORY gets the same delete contract as every
      -- other multi-select list: a CAS lock plus a soft archive. Existing rows
      -- stay visible (revision 0) until the user removes them; nothing is
      -- dropped here, and no schedule rule, occurrence cursor, Artifact,
      -- Obsidian note or credential is touched by the archive commands.
      ALTER TABLE agent_runs ADD COLUMN archived_at TEXT;
      ALTER TABLE agent_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
    `
  }
]

export function migrateDatabase(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _prw_migrations (
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `)

  const hasMigration = sqlite.prepare('SELECT 1 FROM _prw_migrations WHERE id = ?')
  const recordMigration = sqlite.prepare(
    'INSERT INTO _prw_migrations (id, name, applied_at) VALUES (?, ?, ?)'
  )

  const apply = sqlite.transaction((migration: Migration) => {
    sqlite.exec(migration.sql)
    recordMigration.run(migration.id, migration.name, new Date().toISOString())
  })

  for (const migration of migrations) {
    if (!hasMigration.get(migration.id)) {
      if (!migration.disableForeignKeys) {
        apply(migration)
        continue
      }

      const foreignKeys = Number(sqlite.pragma('foreign_keys', { simple: true })) === 1
      if (foreignKeys) sqlite.pragma('foreign_keys = OFF')
      try {
        apply(migration)
      } finally {
        if (foreignKeys) sqlite.pragma('foreign_keys = ON')
      }

      if (foreignKeys) {
        const violations = sqlite.prepare('PRAGMA foreign_key_check').all()
        if (violations.length > 0) {
          throw new Error('foreign key check failed after migration')
        }
      }
    }
  }
}
