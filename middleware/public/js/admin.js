        function dashboard() {
            const reportsModule = window.createReportsModule ? window.createReportsModule() : {};
            return {
                ...reportsModule,
                view: 'overview', darkMode: localStorage.getItem('theme') === 'dark', adminKey: localStorage.getItem('adminKey') || '', keyInput: '', loading: false,
                users: [], policies: [], groupPolicies: [], webuiGroups: [], usage: [],
                systemHealth: { status: 'unknown', checks: {} },
                systemLogs: [],
                configView: {},
                configDraft: {},
                errors: {},
                menuItems: [{ id: 'overview', label: 'Command Center', icon: 'fa-solid fa-gauge-high' }, { id: 'users', label: 'User Hub', icon: 'fa-solid fa-user-gear' }, { id: 'groups', label: 'Group Logic', icon: 'fa-solid fa-sitemap' }, { id: 'policies', label: 'Quota Policies', icon: 'fa-solid fa-shield-halved' }, { id: 'reports', label: 'Reports', icon: 'fa-solid fa-chart-column' }, { id: 'system', label: 'System Health', icon: 'fa-solid fa-heart-pulse' }, { id: 'logs', label: 'Usage Logs', icon: 'fa-solid fa-receipt' }],
                stats: { total_users: 0, total_policies: 0, total_tokens: 0, total_cost: 0, total_requests: 0, last_24h: { tokens: 0, cost: 0, requests: 0, avg_latency_ms: 0, p95_latency_ms: 0, max_latency_ms: 0 }, top_models: [], top_users: [] },
                performance: { summary: {}, recent: [] },
                performanceFilter: { user_id: '', model: '', path: '', status: '' },
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
                            else if (key === 'health') this.systemHealth = value;
                            else if (key === 'config') {
                                this.configView = value.config || {};
                                this.configDraft = { ...(value.config || {}) };
                            } else if (key === 'systemLogs') this.systemLogs = value.logs || [];
                        }
                    } catch (e) { console.error(e); } finally { this.loading = false; }
                },
                async toggleUserStatus(user) { await fetch(`/admin/users/${user.id}`, { method: 'PATCH', headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !user.is_active }) }); await this.refreshAll(); },
                async updateUserPolicy(user) { await fetch(`/admin/users/${user.id}`, { method: 'PATCH', headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ policy_id: user.policy_id }) }); await this.refreshAll(); },
                editPolicy(policy) { this.newPolicy = { id: policy.id, name: policy.name, limit_type: policy.limit_type || 'token', scope_period: policy.scope_period || 'monthly', daily_token_limit: Number(policy.daily_token_limit ?? 0), monthly_token_limit: Number(policy.monthly_token_limit ?? 0), daily_cost_limit: Number(policy.daily_cost_limit ?? 0), monthly_cost_limit: Number(policy.monthly_cost_limit ?? 0), token_limit: Number(policy.token_limit ?? 0), cost_limit: Number(policy.cost_limit ?? 0), formula_kind: policy.formula_kind || 'max_ratio', formula_config: typeof policy.formula_config === 'string' ? JSON.parse(policy.formula_config || '{}') : (policy.formula_config || { threshold: 1, token_weight: 0.5, cost_weight: 0.5 }), allowed_models: policy.allowed_models || '*' }; if (this.newPolicy.formula_config.threshold == null) this.newPolicy.formula_config.threshold = 1; if (this.newPolicy.formula_config.token_weight == null) this.newPolicy.formula_config.token_weight = 0.5; if (this.newPolicy.formula_config.cost_weight == null) this.newPolicy.formula_config.cost_weight = 0.5; },
                async createPolicy() { if (this.policyValidationWarning && !confirm(this.policyValidationWarning + ' Continue?')) return; await fetch('/admin/policies', { method: 'POST', headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify(this.newPolicy) }); this.newPolicy = { id: '', name: '', limit_type: 'token', scope_period: 'monthly', daily_token_limit: 50000, monthly_token_limit: 1000000, daily_cost_limit: 0, monthly_cost_limit: 0, token_limit: 1000000, cost_limit: 0, formula_kind: 'max_ratio', formula_config: { threshold: 1, token_weight: 0.5, cost_weight: 0.5 }, allowed_models: '*' }; this.policyPreview.result = null; await this.refreshAll(); },
                async previewPolicy() { const response = await fetch('/admin/policies/preview', { method: 'POST', headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: this.newPolicy, usage: this.policyPreview.usage }) }); this.policyPreview.result = await response.json(); },
                async deletePolicy(id) { if (confirm('Delete?')) await fetch(`/admin/policies/${id}`, { method: 'DELETE', headers: { 'x-admin-key': this.adminKey } }); await this.refreshAll(); },
                async saveGroupPolicy() { await fetch('/admin/group-policies', { method: 'POST', headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify(this.newGroupPolicy) }); this.newGroupPolicy = { group_name: '', policy_id: '', priority: 0 }; await this.refreshAll(); },
                async deleteGroupMapping(name) { if (!name) return; await fetch(`/admin/group-policies/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'x-admin-key': this.adminKey } }); await this.refreshAll(); },
                async saveConfig() {
                    await fetch('/admin/config', {
                        method: 'POST',
                        headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ config: this.configDraft })
                    });
                    await this.refreshAll();
                },
                async applyPerformanceFilter() { await this.refreshAll(); },
                async resetPerformanceFilter() {
                    this.performanceFilter = { user_id: '', model: '', path: '', status: '' };
                    await this.refreshAll();
                },
                formatNumber(n) { return new Intl.NumberFormat().format(n || 0); },
                formatPolicyType(policy) {
                    const type = policy.limit_type || 'token';
                    const period = policy.scope_period || 'monthly';
                    return type === 'formula' ? `${type}:${policy.formula_kind || 'max_ratio'} / ${period}` : `${type} / ${period}`;
                },
                formulaDetails(policy) {
                    const cfg = typeof policy.formula_config === 'string' ? JSON.parse(policy.formula_config || '{}') : (policy.formula_config || {});
                    if ((policy.formula_kind || 'max_ratio') === 'weighted_ratio') {
                        return `w(tok=${Number(cfg.token_weight ?? 0.5).toFixed(2)}, cost=${Number(cfg.cost_weight ?? 0.5).toFixed(2)}, block≥${Number(cfg.threshold ?? 1).toFixed(2)})`;
                    }
                    return `block≥${Number(cfg.threshold ?? 1).toFixed(2)}`;
                },
                formatPercent(value) {
                    const n = Number(value || 0);
                    return `${(n * 100).toFixed(1)}%`;
                },
                formatDetailValue(key, value) {
                    if (value == null) return '-';
                    if (key.includes('ratio') || key === 'threshold' || key === 'score' || key.includes('weight')) return this.formatPercent(value);
                    if (key.includes('cost')) return value === '∞' ? value : `$${Number(value).toFixed(4)}`;
                    if (typeof value === 'number') return this.formatNumber(value);
                    return String(value);
                },
                detailHelp(key) {
                    const map = {
                        token_ratio: 'Used token amount divided by the token limit.',
                        cost_ratio: 'Used cost divided by the cost limit.',
                        remaining_tokens: 'How many tokens are left before this window blocks.',
                        remaining_cost: 'How much cost budget is left before this window blocks.',
                        score: 'Final formula score used for the allow/block decision.',
                        threshold: 'If score reaches or exceeds this value, the request is blocked.',
                        token_weight: 'How much token usage contributes to the formula score.',
                        cost_weight: 'How much cost usage contributes to the formula score.',
                        warning: 'Extra note from the evaluator.'
                    };
                    return map[key] || 'Evaluation detail from the quota engine.';
                },
                detailLabel(key) {
                    const map = {
                        token_ratio: 'Token ratio',
                        cost_ratio: 'Cost ratio',
                        remaining_tokens: 'Remaining tokens',
                        remaining_cost: 'Remaining cost',
                        score: 'Score',
                        threshold: 'Threshold',
                        token_weight: 'Token weight',
                        cost_weight: 'Cost weight',
                        warning: 'Note'
                    };
                    return map[key] || key;
                },
                describePreviewWindow(details) {
                    if (!details) return [{ label: 'No active limits', help: 'This window is not contributing to a block right now.', value: '-' }];
                    return Object.entries(details).map(([key, value]) => ({
                        label: this.detailLabel(key),
                        help: this.detailHelp(key),
                        value: this.formatDetailValue(key, value)
                    }));
                },
                formatLimitValue(value, kind='token') {
                    const n = Number(value || 0);
                    if (n <= 0) return '∞';
                    return kind === 'cost' ? `$${n.toFixed(4)}` : `${this.formatNumber(n)}`;
                },
                remainingValue(limit, used, kind='token') {
                    const n = Number(limit || 0);
                    if (n <= 0) return '∞';
                    const rem = Math.max(0, n - Number(used || 0));
                    return kind === 'cost' ? `$${rem.toFixed(4)}` : `${this.formatNumber(rem)}`;
                },
                formatRemaining(user, period) {
                    const p = user || {};
                    const usage = p.effective_usage?.[period] || { tokens: 0, cost: 0 };
                    const type = p.effective_limit_type || 'token';
                    const policy = this.policies.find(x => x.id === p.effective_policy_id) || {};
                    if (type === 'token') return `remaining ${this.remainingValue(policy[`${period}_token_limit`], usage.tokens)} tok`;
                    if (type === 'cost') return `remaining ${this.remainingValue(policy[`${period}_cost_limit`], usage.cost, 'cost')}`;
                    return `remaining ${this.remainingValue(policy[`${period}_token_limit`], usage.tokens)} tok / ${this.remainingValue(policy[`${period}_cost_limit`], usage.cost, 'cost')}`;
                },
                formatPolicyLimit(policy) {
                    const type = policy.limit_type || 'token';
                    if (type === 'token') return `D:${this.formatLimitValue(policy.daily_token_limit)} / M:${this.formatLimitValue(policy.monthly_token_limit)} tokens`;
                    if (type === 'cost') return `D:${this.formatLimitValue(policy.daily_cost_limit, 'cost')} / M:${this.formatLimitValue(policy.monthly_cost_limit, 'cost')}`;
                    return `D:${this.formatLimitValue(policy.daily_token_limit)} tok + ${this.formatLimitValue(policy.daily_cost_limit, 'cost')} / M:${this.formatLimitValue(policy.monthly_token_limit)} tok + ${this.formatLimitValue(policy.monthly_cost_limit, 'cost')} (${this.formulaDetails(policy)})`;
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
