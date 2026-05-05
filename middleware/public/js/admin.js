        function dashboard() {
            const reportsModule = window.createReportsModule ? window.createReportsModule() : {};
            const policiesModule = window.createPoliciesModule ? window.createPoliciesModule() : {};
            return {
                ...reportsModule,
                ...policiesModule,
                view: 'overview', systemTab: 'router', routerPanel: 'models', darkMode: localStorage.getItem('theme') === 'dark', adminKey: localStorage.getItem('adminKey') || '', keyInput: '', loading: false,
                users: [], policies: [], groupPolicies: [], webuiGroups: [], usage: [],
                systemHealth: { status: 'unknown', checks: {} },
                systemLogs: [],
                configView: {},
                configDraft: {},
                virtualModelsDraft: [],
                routerRulesDraft: { premium_keyword_score: 2, long_context_tokens: 8000, premium_prompt_tokens: 4000, signal_rules: [] },
                virtualRouterPolicyDraft: { premium_model_ids: [], premium_allowed_groups: [], premium_daily_cost_limit: 0, premium_monthly_cost_limit: 0, hybrid_classifier_enabled: false, hybrid_classifier_model: 'openai/gpt-4.1-nano', hybrid_confidence_threshold: 0.55, hybrid_classifier_timeout_ms: 1000, hybrid_classifier_cache_ttl_ms: 300000 },
                configValidation: { errors: [], warnings: [], success: '' },
                routePreview: {
                    model: 'virtual/auto-balanced',
                    prompt: 'Please analyze this system architecture, compare tradeoffs, and identify likely root causes.',
                    max_tokens: 1024,
                    result: null,
                    error: '',
                    loading: false,
                },
                errors: {},
                menuItems: [{ id: 'overview', label: 'Command Center', icon: 'fa-solid fa-gauge-high' }, { id: 'users', label: 'User Hub', icon: 'fa-solid fa-user-gear' }, { id: 'groups', label: 'Group Logic', icon: 'fa-solid fa-sitemap' }, { id: 'policies', label: 'Quota Policies', icon: 'fa-solid fa-shield-halved' }, { id: 'reports', label: 'Reports', icon: 'fa-solid fa-chart-column' }, { id: 'system', label: 'System', icon: 'fa-solid fa-sliders' }, { id: 'logs', label: 'Usage Logs', icon: 'fa-solid fa-receipt' }],
                systemTabs: [
                    { id: 'router', label: 'Router', icon: 'fa-solid fa-route', hint: 'Virtual model, premium gate, และ preview การ route' },
                    { id: 'health', label: 'Health', icon: 'fa-solid fa-heart-pulse', hint: 'Runtime dependency status' },
                    { id: 'config', label: 'Config', icon: 'fa-solid fa-code', hint: 'Raw config editor' },
                    { id: 'runtime', label: 'Logs', icon: 'fa-solid fa-terminal', hint: 'System runtime logs' },
                ],
                routerPanels: [
                    { id: 'models', label: 'Models', icon: 'fa-solid fa-layer-group', hint: 'กำหนด strategy และ candidate ของ virtual model' },
                    { id: 'rules', label: 'Signals', icon: 'fa-solid fa-wave-square', hint: 'สร้าง rule ไทย/อังกฤษและดูผลต่อการ route' },
                    { id: 'policy', label: 'Policy', icon: 'fa-solid fa-shield-halved', hint: 'กำหนด premium gate และ hybrid classifier' },
                    { id: 'preview', label: 'Preview', icon: 'fa-solid fa-flask', hint: 'ทดลอง prompt และดูผลการตัดสินใจ route' },
                ],
                stats: { total_users: 0, total_policies: 0, total_tokens: 0, total_cost: 0, total_requests: 0, last_24h: { tokens: 0, cost: 0, requests: 0, avg_latency_ms: 0, p95_latency_ms: 0, max_latency_ms: 0 }, top_models: [], top_users: [] },
                performance: { summary: {}, recent: [] },
                performanceFilter: { user_id: '', model: '', requested_model: '', resolved_model: '', routing_reason: '', path: '', status: '' },
                newPolicy: { id: '', name: '', limit_type: 'token', scope_period: 'monthly', daily_token_limit: 50000, monthly_token_limit: 1000000, daily_cost_limit: 0, monthly_cost_limit: 0, token_limit: 1000000, cost_limit: 0, formula_kind: 'max_ratio', formula_config: { threshold: 1, token_weight: 0.5, cost_weight: 0.5 }, allowed_models: '*' },
                policyPreview: { usage: { daily: { tokens: 1000, cost: 0.1 }, monthly: { tokens: 10000, cost: 1 } }, result: null },
                newGroupPolicy: { group_name: '', policy_id: '', priority: 0 },
                get statsCards() { 
                    return [
                        { label: 'Total Identities', value: this.stats.total_users, icon: 'fa-solid fa-users', context: 'Registered in DB' },
                        { label: 'Network Reqs', value: this.formatNumber(this.stats.total_requests), icon: 'fa-solid fa-bolt', context: 'All-time volume' },
                        { label: 'Token Consumption', value: this.formatNumber(this.stats.total_tokens), icon: 'fa-solid fa-fire', context: 'Global burn rate' },
                        { label: 'Total Cost', value: '$' + Number(this.stats.total_cost || 0).toFixed(4), icon: 'fa-solid fa-dollar-sign', context: 'All-time cost' },
                        { label: 'P95 Latency (24h)', value: Math.round(this.stats.last_24h.p95_latency_ms || 0) + ' ms', icon: 'fa-solid fa-stopwatch', context: 'Prompt to response' }
                    ]; 
                },
                get groupRows() {
                    const mapped = new Map(this.groupPolicies.map(gp => [gp.group_name, gp]));
                    const names = [...new Set([
                        ...this.webuiGroups.map(g => g.name),
                        ...this.groupPolicies.map(gp => gp.group_name)
                    ])].sort((a, b) => a.localeCompare(b));
                    return names.map(name => mapped.get(name) || { group_name: name, policy_id: '', priority: null });
                },
                get policyValidationWarning() {
                    const p = this.newPolicy;
                    if (p.limit_type === 'token' && Number(p.daily_token_limit || 0) === 0 && Number(p.monthly_token_limit || 0) === 0) {
                        return 'Both daily and monthly token limits are 0, so this policy becomes fully unlimited.';
                    }
                    if (p.limit_type === 'cost' && Number(p.daily_cost_limit || 0) === 0 && Number(p.monthly_cost_limit || 0) === 0) {
                        return 'Both daily and monthly cost limits are 0, so this policy becomes fully unlimited.';
                    }
                    if (p.limit_type === 'formula' && Number(p.daily_token_limit || 0) === 0 && Number(p.monthly_token_limit || 0) === 0 && Number(p.daily_cost_limit || 0) === 0 && Number(p.monthly_cost_limit || 0) === 0) {
                        return 'All daily/monthly formula thresholds are 0, so this policy becomes fully unlimited.';
                    }
                    return '';
                },
                viewDescription(view) {
                    return {
                        overview: 'Executive health, spend, token burn, and model volume.',
                        users: 'Assign policies, review group inheritance, and control user access.',
                        groups: 'Map OpenWebUI groups to middleware quota policies.',
                        policies: 'Build quota formulas, preview enforcement, and gate allowed models.',
                        reports: 'Analyze costs, usage distribution, quota events, and model demand.',
                        system: 'Configure virtual routing, health, runtime config, and system logs.',
                        logs: 'Trace request latency, routing decisions, status, and cost events.',
                    }[view] || 'AI Control Plane administration';
                },
                async init() { if (this.adminKey) { await this.refreshAll(); setInterval(() => this.refreshAll(), 15000); } },
                toggleTheme() { this.darkMode = !this.darkMode; localStorage.setItem('theme', this.darkMode ? 'dark' : 'light'); },
                saveKey() { this.adminKey = this.keyInput; localStorage.setItem('adminKey', this.adminKey); this.init(); },
                logout() { this.adminKey = ''; localStorage.removeItem('adminKey'); },
                async refreshAll() {
                    this.loading = true;
                    this.errors = {};
                    try {
                        const headers = { 'x-admin-key': this.adminKey };
                        const perfParams = new URLSearchParams();
                        Object.entries(this.performanceFilter).forEach(([k, v]) => { if (v) perfParams.set(k, String(v)); });
                        const perfUrl = '/admin/performance' + (perfParams.toString() ? `?${perfParams.toString()}` : '');

                        const reportParams = new URLSearchParams();
                        reportParams.set('range', this.reportFilter.range);
                        reportParams.set('limit', String(this.reportFilter.limit));

                        const endpoints = {
                            users: '/admin/users',
                            policies: '/admin/policies',
                            usage: '/admin/usage',
                            groupPolicies: '/admin/group-policies',
                            webuiGroups: '/admin/openwebui-groups',
                            stats: '/admin/stats',
                            performance: perfUrl,
                            reportsSummary: `/admin/reports/summary?${reportParams.toString()}`,
                            reportsUsers: `/admin/reports/users?${reportParams.toString()}`,
                            reportsGroups: `/admin/reports/groups?${reportParams.toString()}`,
                            reportsCosts: `/admin/reports/costs?${reportParams.toString()}`,
                            reportsQuotaEvents: `/admin/reports/quota-events?${reportParams.toString()}`,
                            reportsUserModels: `/admin/reports/user-models?${reportParams.toString()}`,
                            reportsModelUsers: `/admin/reports/model-users?${reportParams.toString()}`,
                            health: '/admin/health',
                            config: '/admin/config',
                            systemLogs: '/admin/system-logs'
                        };

                        const results = await Promise.all(Object.entries(endpoints).map(async ([key, url]) => {
                            try {
                                const response = await fetch(url, { headers });
                                if (!response.ok) {
                                    const text = await response.text();
                                    throw new Error(text || `${key} failed with ${response.status}`);
                                }
                                return { key, value: await response.json(), error: null };
                            } catch (error) {
                                return { key, value: null, error };
                            }
                        }));

                        for (const result of results) {
                            if (result.error) {
                                this.errors[result.key] = String(result.error?.message || result.error);
                                console.error(result.error);
                                continue;
                            }
                            const { key, value } = result;
                            if (key === 'users') this.users = value;
                            else if (key === 'policies') this.policies = value;
                            else if (key === 'usage') this.usage = value;
                            else if (key === 'groupPolicies') this.groupPolicies = value;
                            else if (key === 'webuiGroups') this.webuiGroups = value;
                            else if (key === 'stats') this.stats = value;
                            else if (key === 'performance') this.performance = value;
                            else if (key === 'reportsSummary') this.reports.summary = value;
                            else if (key === 'reportsUsers') this.reports.users = value;
                            else if (key === 'reportsGroups') this.reports.groups = value;
                            else if (key === 'reportsCosts') this.reports.costs = value;
                            else if (key === 'reportsQuotaEvents') this.reports.quotaEvents = value;
                            else if (key === 'reportsUserModels') this.reports.userModels = value;
                            else if (key === 'reportsModelUsers') this.reports.modelUsers = value;
                            else if (key === 'health') this.systemHealth = value;
                            else if (key === 'config') {
                                this.configView = value.masked || {};
                                this.configDraft = { ...(value.masked || {}) };
                                this.loadVirtualRouterDrafts();
                            } else if (key === 'systemLogs') this.systemLogs = value.logs || [];
                        }
                    } catch (e) { console.error(e); } finally { this.loading = false; }
                },
                parseJsonConfigValue(key, fallback) {
                    const raw = this.configDraft?.[key];
                    if (!raw) return fallback;
                    try { return JSON.parse(raw); } catch { return fallback; }
                },
                parseLines(value) {
                    return String(value || '').split(/\n+/).map(v => v.trim()).filter(Boolean);
                },
                candidateRole(strategy, index) {
                    const roles = {
                        cheap_first: ['เส้นทางประหยัดเริ่มต้น', 'สำรอง', 'สำรอง'],
                        balanced: ['เส้นทางเริ่มต้น', 'สำรอง / งานเบา', 'เส้นทาง premium reasoning'],
                        premium: ['เลือกเสมอ', 'สำรอง', 'สำรอง'],
                        code: ['เส้นทางงาน coding', 'สำรองสำหรับงานไม่ใช่ code', 'เส้นทาง premium coding/reasoning'],
                        long_context: ['เส้นทาง long-context', 'เส้นทาง context ปกติ', 'สำรอง'],
                    };
                    return (roles[strategy] || [])[index] || `candidate ${index + 1}`;
                },
                candidateLines(model) {
                    return this.parseLines(model?.candidatesText).map((candidate, index) => ({ candidate, role: this.candidateRole(model.strategy, index) }));
                },
                strategyDescription(strategy) {
                    const map = {
                        cheap_first: 'เลือก candidate #1 เสมอ เหมาะกับงานเบาและต้องการคุมต้นทุน',
                        balanced: 'ถ้าเข้าเงื่อนไข premium reasoning จะเลือก candidate #3 ไม่เช่นนั้นเลือก candidate #1',
                        premium: 'เลือก candidate #1 เสมอ และปกติควรถูกป้องกันด้วย premium gate',
                        code: 'ถ้าเจอ coding signal จะเลือก candidate #1; ถ้าเข้า premium reasoning จะเลือก candidate #3; นอกนั้นเลือก candidate #2',
                        long_context: 'ถ้าเป็น long-context จะเลือก candidate #1; context ปกติเลือก candidate #2',
                    };
                    return map[strategy] || 'ไม่รู้จัก strategy นี้';
                },
                ruleEffectText(rule) {
                    const weight = Number(rule?.weight || 0);
                    const parts = [];
                    if (weight > 0) parts.push(`เพิ่ม +${weight} ให้ premium score`);
                    else parts.push('ไม่เพิ่ม premium score');
                    if (rule?.coding) parts.push('ระบุ request เป็นงาน coding');
                    parts.push(`เข้า premium เมื่อคะแนนรวม ≥ ${this.routerRulesDraft.premium_keyword_score}`);
                    return parts.join(' · ');
                },
                ruleEffectClass(rule) {
                    if (rule?.coding && Number(rule?.weight || 0) > 0) return 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/20 dark:text-indigo-300';
                    if (rule?.coding) return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-300';
                    if (Number(rule?.weight || 0) > 0) return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300';
                    return 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400';
                },
                validateVirtualRouterDrafts({ requirePrompt = false } = {}) {
                    const errors = [];
                    const warnings = [];
                    const strategies = new Set(['cheap_first', 'balanced', 'premium', 'code', 'long_context']);
                    const seen = new Set();
                    const ids = [];

                    this.virtualModelsDraft.forEach((model, index) => {
                        const label = model.id || `model #${index + 1}`;
                        const id = String(model.id || '').trim();
                        const candidates = this.parseLines(model.candidatesText);
                        if (!id) errors.push(`${label}: id is required`);
                        else {
                            if (!id.startsWith('virtual/')) warnings.push(`${id}: virtual model ids should usually start with virtual/`);
                            if (seen.has(id)) errors.push(`${id}: duplicate virtual model id`);
                            seen.add(id);
                            ids.push(id);
                        }
                        if (!String(model.name || '').trim()) errors.push(`${label}: display name is required`);
                        if (!String(model.description || '').trim()) errors.push(`${label}: description is required`);
                        if (!strategies.has(String(model.strategy || '').trim())) errors.push(`${label}: invalid strategy`);
                        if (!candidates.length) errors.push(`${label}: add at least one candidate model`);
                        if (candidates.some(candidate => candidate.startsWith('virtual/'))) warnings.push(`${label}: candidates should be real upstream models, not virtual models`);
                    });

                    if (!ids.length) errors.push('At least one virtual model is required');
                    const premiumIds = this.parseLines(this.virtualRouterPolicyDraft.premium_model_ids);
                    premiumIds.forEach((id) => { if (!seen.has(id)) errors.push(`Premium model id ${id} does not exist in virtual models`); });
                    ['premium_daily_cost_limit', 'premium_monthly_cost_limit'].forEach((key) => {
                        const value = Number(this.virtualRouterPolicyDraft[key] || 0);
                        if (!Number.isFinite(value) || value < 0) errors.push(`${key} must be a non-negative number`);
                    });
                    if (this.virtualRouterPolicyDraft.hybrid_classifier_enabled && !String(this.virtualRouterPolicyDraft.hybrid_classifier_model || '').trim()) {
                        errors.push('hybrid_classifier_model is required when hybrid classifier is enabled');
                    }
                    const threshold = Number(this.virtualRouterPolicyDraft.hybrid_confidence_threshold ?? 0.55);
                    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) errors.push('hybrid_confidence_threshold must be between 0 and 1');
                    ['hybrid_classifier_timeout_ms', 'hybrid_classifier_cache_ttl_ms'].forEach((key) => {
                        const value = Number(this.virtualRouterPolicyDraft[key] ?? 0);
                        if (!Number.isFinite(value) || value < 0) errors.push(`${key} must be a non-negative number`);
                    });

                    if (this.configDraft.VIRTUAL_MODELS_JSON) {
                        try { JSON.parse(this.configDraft.VIRTUAL_MODELS_JSON); } catch (e) { errors.push(`VIRTUAL_MODELS_JSON is invalid JSON: ${e.message}`); }
                    }
                    const ruleLabels = new Set();
                    const rules = this.routerRulesDraft.signal_rules || [];
                    if (!rules.length) errors.push('At least one signal rule is required');
                    rules.forEach((rule, index) => {
                        const label = String(rule.label || '').trim();
                        const keywords = this.parseLines(rule.keywordsText);
                        if (!label) errors.push(`signal rule #${index + 1}: label is required`);
                        else if (ruleLabels.has(label)) errors.push(`${label}: duplicate signal rule label`);
                        else ruleLabels.add(label);
                        if (!keywords.length) errors.push(`${label || `signal rule #${index + 1}`}: add at least one keyword`);
                        const weight = Number(rule.weight ?? 1);
                        if (!Number.isFinite(weight) || weight < 0) errors.push(`${label}: weight must be a non-negative number`);
                    });
                    ['premium_keyword_score', 'long_context_tokens', 'premium_prompt_tokens'].forEach((key) => {
                        const value = Number(this.routerRulesDraft[key]);
                        if (!Number.isFinite(value) || value < 0) errors.push(`${key} must be a non-negative number`);
                    });

                    if (this.configDraft.VIRTUAL_ROUTER_CONFIG_JSON) {
                        try { JSON.parse(this.configDraft.VIRTUAL_ROUTER_CONFIG_JSON); } catch (e) { errors.push(`VIRTUAL_ROUTER_CONFIG_JSON is invalid JSON: ${e.message}`); }
                    }
                    if (this.configDraft.VIRTUAL_ROUTER_RULES_JSON) {
                        try { JSON.parse(this.configDraft.VIRTUAL_ROUTER_RULES_JSON); } catch (e) { errors.push(`VIRTUAL_ROUTER_RULES_JSON is invalid JSON: ${e.message}`); }
                    }

                    if (requirePrompt) {
                        if (!String(this.routePreview.prompt || '').trim()) errors.push('Preview prompt is required');
                        if (!String(this.routePreview.model || '').trim()) errors.push('Preview requested model is required');
                        const maxTokens = Number(this.routePreview.max_tokens || 0);
                        if (!Number.isFinite(maxTokens) || maxTokens <= 0) errors.push('Preview max tokens must be greater than 0');
                    }

                    return { ok: errors.length === 0, errors, warnings };
                },
                loadVirtualRouterDrafts() {
                    this.virtualModelsDraft = this.parseJsonConfigValue('VIRTUAL_MODELS_JSON', []).map((model) => ({
                        id: model.id || '',
                        name: model.name || '',
                        description: model.description || '',
                        strategy: model.strategy || 'balanced',
                        candidatesText: Array.isArray(model.candidates) ? model.candidates.join('\n') : '',
                    }));
                    if (!this.virtualModelsDraft.some((model) => model.id === this.routePreview.model)) {
                        this.routePreview.model = this.virtualModelsDraft[0]?.id || 'virtual/auto-balanced';
                    }
                    const policy = this.parseJsonConfigValue('VIRTUAL_ROUTER_CONFIG_JSON', {
                        premium_model_ids: [], premium_allowed_groups: [], premium_daily_cost_limit: 0, premium_monthly_cost_limit: 0, hybrid_classifier_enabled: false, hybrid_classifier_model: 'openai/gpt-4.1-nano', hybrid_confidence_threshold: 0.55, hybrid_classifier_timeout_ms: 1000, hybrid_classifier_cache_ttl_ms: 300000,
                    });
                    this.virtualRouterPolicyDraft = {
                        premium_model_ids: Array.isArray(policy.premium_model_ids) ? policy.premium_model_ids.join('\n') : '',
                        premium_allowed_groups: Array.isArray(policy.premium_allowed_groups) ? policy.premium_allowed_groups.join('\n') : '',
                        premium_daily_cost_limit: Number(policy.premium_daily_cost_limit || 0),
                        premium_monthly_cost_limit: Number(policy.premium_monthly_cost_limit || 0),
                        hybrid_classifier_enabled: Boolean(policy.hybrid_classifier_enabled),
                        hybrid_classifier_model: String(policy.hybrid_classifier_model || 'openai/gpt-4.1-nano'),
                        hybrid_confidence_threshold: Number(policy.hybrid_confidence_threshold ?? 0.55),
                        hybrid_classifier_timeout_ms: Number(policy.hybrid_classifier_timeout_ms ?? 1000),
                        hybrid_classifier_cache_ttl_ms: Number(policy.hybrid_classifier_cache_ttl_ms ?? 300000),
                    };
                    const rules = this.parseJsonConfigValue('VIRTUAL_ROUTER_RULES_JSON', { premium_keyword_score: 2, long_context_tokens: 8000, premium_prompt_tokens: 4000, signal_rules: [] });
                    this.routerRulesDraft = {
                        premium_keyword_score: Number(rules.premium_keyword_score ?? 2),
                        long_context_tokens: Number(rules.long_context_tokens ?? 8000),
                        premium_prompt_tokens: Number(rules.premium_prompt_tokens ?? 4000),
                        signal_rules: Array.isArray(rules.signal_rules) ? rules.signal_rules.map((rule) => ({
                            label: rule.label || '',
                            description: rule.description || '',
                            weight: Number(rule.weight ?? 1),
                            coding: Boolean(rule.coding),
                            keywordsText: Array.isArray(rule.keywords) ? rule.keywords.join('\n') : '',
                        })) : [],
                    };
                },
                addRouterRuleDraft() {
                    this.routerRulesDraft.signal_rules.push({ label: '', description: '', weight: 1, coding: false, keywordsText: '' });
                },
                removeRouterRuleDraft(index) {
                    this.routerRulesDraft.signal_rules.splice(index, 1);
                },
                addVirtualModelDraft() {
                    this.virtualModelsDraft.push({ id: '', name: '', description: '', strategy: 'balanced', candidatesText: '' });
                },
                removeVirtualModelDraft(index) {
                    this.virtualModelsDraft.splice(index, 1);
                },
                syncVirtualRouterDraftsToConfig() {
                    this.configDraft.VIRTUAL_MODELS_JSON = JSON.stringify(this.virtualModelsDraft.map((model) => ({
                        id: String(model.id || '').trim(),
                        name: String(model.name || '').trim(),
                        description: String(model.description || '').trim(),
                        strategy: String(model.strategy || 'balanced').trim(),
                        candidates: this.parseLines(model.candidatesText),
                    })).filter(model => model.id && model.name && model.description && model.candidates.length), null, 2);
                    this.configDraft.VIRTUAL_ROUTER_CONFIG_JSON = JSON.stringify({
                        premium_model_ids: this.parseLines(this.virtualRouterPolicyDraft.premium_model_ids),
                        premium_allowed_groups: this.parseLines(this.virtualRouterPolicyDraft.premium_allowed_groups),
                        premium_daily_cost_limit: Number(this.virtualRouterPolicyDraft.premium_daily_cost_limit || 0),
                        premium_monthly_cost_limit: Number(this.virtualRouterPolicyDraft.premium_monthly_cost_limit || 0),
                        hybrid_classifier_enabled: Boolean(this.virtualRouterPolicyDraft.hybrid_classifier_enabled),
                        hybrid_classifier_model: String(this.virtualRouterPolicyDraft.hybrid_classifier_model || 'openai/gpt-4.1-nano').trim(),
                        hybrid_confidence_threshold: Number(this.virtualRouterPolicyDraft.hybrid_confidence_threshold ?? 0.55),
                        hybrid_classifier_timeout_ms: Number(this.virtualRouterPolicyDraft.hybrid_classifier_timeout_ms ?? 1000),
                        hybrid_classifier_cache_ttl_ms: Number(this.virtualRouterPolicyDraft.hybrid_classifier_cache_ttl_ms ?? 300000),
                    }, null, 2);
                    this.configDraft.VIRTUAL_ROUTER_RULES_JSON = JSON.stringify({
                        premium_keyword_score: Number(this.routerRulesDraft.premium_keyword_score ?? 2),
                        long_context_tokens: Number(this.routerRulesDraft.long_context_tokens ?? 8000),
                        premium_prompt_tokens: Number(this.routerRulesDraft.premium_prompt_tokens ?? 4000),
                        signal_rules: (this.routerRulesDraft.signal_rules || []).map((rule) => ({
                            label: String(rule.label || '').trim(),
                            description: String(rule.description || '').trim(),
                            weight: Number(rule.weight ?? 1),
                            coding: Boolean(rule.coding),
                            keywords: this.parseLines(rule.keywordsText),
                        })).filter(rule => rule.label && rule.keywords.length),
                    }, null, 2);
                },
                async saveConfig() {
                    this.configValidation = { errors: [], warnings: [], success: '' };
                    const validation = this.validateVirtualRouterDrafts();
                    if (!validation.ok) {
                        this.configValidation = { ...validation, success: '' };
                        return;
                    }
                    this.syncVirtualRouterDraftsToConfig();
                    const updates = {};
                    Object.keys(this.configDraft || {}).forEach((key) => {
                        if (this.configDraft[key] !== this.configView[key]) updates[key] = this.configDraft[key];
                    });
                    if (Object.keys(updates).length === 0) return;
                    const response = await fetch('/admin/config', {
                        method: 'POST',
                        headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ config: updates })
                    });
                    if (!response.ok) throw new Error(await response.text());
                    this.configValidation = { errors: [], warnings: validation.warnings, success: 'Config saved successfully' };
                    await this.refreshAll();
                },
                async previewRouteDecision() {
                    const validation = this.validateVirtualRouterDrafts({ requirePrompt: true });
                    this.configValidation = { ...validation, success: '' };
                    if (!validation.ok) return;
                    this.syncVirtualRouterDraftsToConfig();
                    this.routePreview.loading = true;
                    this.routePreview.error = '';
                    this.routePreview.result = null;
                    try {
                        const response = await fetch('/admin/router/preview', {
                            method: 'POST',
                            headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model: this.routePreview.model,
                                prompt: this.routePreview.prompt,
                                max_tokens: Number(this.routePreview.max_tokens || 1024),
                                virtualModelsJson: this.configDraft.VIRTUAL_MODELS_JSON,
                                routerRulesJson: this.configDraft.VIRTUAL_ROUTER_RULES_JSON,
                                routerConfigJson: this.configDraft.VIRTUAL_ROUTER_CONFIG_JSON,
                            }),
                        });
                        const payload = await response.json().catch(() => null);
                        if (!response.ok || !payload?.success) throw new Error(payload?.error || await response.text());
                        this.routePreview.result = payload;
                    } catch (error) {
                        this.routePreview.error = String(error?.message || error);
                    } finally {
                        this.routePreview.loading = false;
                    }
                },
                applyPerformanceFilter() { this.refreshAll(); },
                resetPerformanceFilter() {
                    this.performanceFilter = { user_id: '', model: '', requested_model: '', resolved_model: '', routing_reason: '', path: '', status: '' };
                    this.refreshAll();
                },
                async toggleUserStatus(user) { await fetch(`/admin/users/${user.id}`, { method: 'PATCH', headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !user.is_active }) }); await this.refreshAll(); },
                async updateUserPolicy(user) { await fetch(`/admin/users/${user.id}`, { method: 'PATCH', headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ policy_id: user.policy_id }) }); await this.refreshAll(); },
                formatNumber(n) { return new Intl.NumberFormat().format(n || 0); },
                formatResolvedModel(row) {
                    const requested = row?.requested_model || '';
                    const resolved = row?.resolved_model || '';
                    const model = row?.model || '';
                    if (resolved && resolved !== requested) return '→ ' + resolved;
                    if (!resolved && model && model !== requested) return '→ ' + model;
                    if (resolved && resolved === requested) return 'same model';
                    if (model && model === requested) return 'same model';
                    return '-';
                },
                barStyle(value, rows, field = 'cost') {
                    const nums = (rows || []).map(r => Number(r?.[field] || 0));
                    const max = Math.max(0, ...nums);
                    const current = Number(value || 0);
                    const width = max > 0 ? Math.max(2, (current / max) * 100) : 0;
                    return `width:${width}%`;
                },
                formatTrend(value) {
                    const n = Number(value || 0);
                    const sign = n > 0 ? '+' : '';
                    return `${sign}${n.toFixed(1)}% vs previous`;
                },
                metricLabel() {
                    return this.reportFilter.metric === 'tokens' ? 'Token' : 'Cost';
                },
                trendClass(value, inverse = false) {
                    const n = Number(value || 0);
                    if (n === 0) return 'text-slate-400';
                    const positiveGood = inverse ? n < 0 : n > 0;
                    return positiveGood ? 'text-emerald-500' : 'text-rose-500';
                },
                formatQuotaCategory(category) {
                    const map = {
                        daily_token: 'Daily token',
                        monthly_token: 'Monthly token',
                        daily_cost: 'Daily cost',
                        monthly_cost: 'Monthly cost',
                        formula: 'Formula',
                        quota: 'Quota'
                    };
                    return map[category] || category;
                },
                exportCsv(filename, rows) {
                    const data = Array.isArray(rows) ? rows : [];
                    if (!data.length) return;
                    const keys = [...new Set(data.flatMap(row => Object.keys(row || {})))];
                    const escape = (v) => {
                        const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
                        return '"' + s.replaceAll('"', '""') + '"';
                    };
                    const csv = [keys.join(','), ...data.map(row => keys.map(k => escape(row[k])).join(','))].join('\n');
                    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    URL.revokeObjectURL(url);
                },
                formatDate(d) { return new Date(d).toLocaleDateString(); },
                formatDateTimeShort(d) { return new Date(d).toLocaleTimeString(); }
            }
        }
