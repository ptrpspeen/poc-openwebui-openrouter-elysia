        function dashboard() {
            const reportsModule = window.createReportsModule ? window.createReportsModule() : {};
            const policiesModule = window.createPoliciesModule ? window.createPoliciesModule() : {};
            return {
                ...reportsModule,
                ...policiesModule,
                view: 'overview', systemTab: 'router', darkMode: localStorage.getItem('theme') === 'dark', adminKey: localStorage.getItem('adminKey') || '', keyInput: '', loading: false,
                users: [], policies: [], groupPolicies: [], webuiGroups: [], usage: [],
                systemHealth: { status: 'unknown', checks: {} },
                systemLogs: [],
                configView: {},
                configDraft: {},
                virtualModelsDraft: [],
                virtualRouterPolicyDraft: { premium_model_ids: [], premium_allowed_groups: [], premium_daily_cost_limit: 0, premium_monthly_cost_limit: 0 },
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
                    { id: 'router', label: 'Router', icon: 'fa-solid fa-route', hint: 'Virtual models, premium gate, route preview' },
                    { id: 'health', label: 'Health', icon: 'fa-solid fa-heart-pulse', hint: 'Runtime dependency status' },
                    { id: 'config', label: 'Config', icon: 'fa-solid fa-code', hint: 'Raw config editor' },
                    { id: 'runtime', label: 'Logs', icon: 'fa-solid fa-terminal', hint: 'System runtime logs' },
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

                    if (this.configDraft.VIRTUAL_MODELS_JSON) {
                        try { JSON.parse(this.configDraft.VIRTUAL_MODELS_JSON); } catch (e) { errors.push(`VIRTUAL_MODELS_JSON is invalid JSON: ${e.message}`); }
                    }
                    if (this.configDraft.VIRTUAL_ROUTER_CONFIG_JSON) {
                        try { JSON.parse(this.configDraft.VIRTUAL_ROUTER_CONFIG_JSON); } catch (e) { errors.push(`VIRTUAL_ROUTER_CONFIG_JSON is invalid JSON: ${e.message}`); }
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
                        premium_model_ids: [], premium_allowed_groups: [], premium_daily_cost_limit: 0, premium_monthly_cost_limit: 0,
                    });
                    this.virtualRouterPolicyDraft = {
                        premium_model_ids: Array.isArray(policy.premium_model_ids) ? policy.premium_model_ids.join('\n') : '',
                        premium_allowed_groups: Array.isArray(policy.premium_allowed_groups) ? policy.premium_allowed_groups.join('\n') : '',
                        premium_daily_cost_limit: Number(policy.premium_daily_cost_limit || 0),
                        premium_monthly_cost_limit: Number(policy.premium_monthly_cost_limit || 0),
                    };
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
