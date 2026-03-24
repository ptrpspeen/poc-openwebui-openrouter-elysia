window.createPoliciesModule = function () {
    return {
        newPolicy: { id: '', name: '', limit_type: 'token', scope_period: 'monthly', daily_token_limit: 50000, monthly_token_limit: 1000000, daily_cost_limit: 0, monthly_cost_limit: 0, token_limit: 1000000, cost_limit: 0, formula_kind: 'max_ratio', formula_config: { threshold: 1, token_weight: 0.5, cost_weight: 0.5 }, allowed_models: '*' },
        policyPreview: { usage: { daily: { tokens: 1000, cost: 0.1 }, monthly: { tokens: 10000, cost: 1 } }, result: null },
        newGroupPolicy: { group_name: '', policy_id: '', priority: 0 },

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
        editPolicy(policy) {
            this.newPolicy = {
                id: policy.id,
                name: policy.name,
                limit_type: policy.limit_type || 'token',
                scope_period: policy.scope_period || 'monthly',
                daily_token_limit: Number(policy.daily_token_limit ?? 0),
                monthly_token_limit: Number(policy.monthly_token_limit ?? 0),
                daily_cost_limit: Number(policy.daily_cost_limit ?? 0),
                monthly_cost_limit: Number(policy.monthly_cost_limit ?? 0),
                token_limit: Number(policy.token_limit ?? 0),
                cost_limit: Number(policy.cost_limit ?? 0),
                formula_kind: policy.formula_kind || 'max_ratio',
                formula_config: typeof policy.formula_config === 'string'
                    ? JSON.parse(policy.formula_config || '{}')
                    : (policy.formula_config || { threshold: 1, token_weight: 0.5, cost_weight: 0.5 }),
                allowed_models: policy.allowed_models || '*'
            };
            if (this.newPolicy.formula_config.threshold == null) this.newPolicy.formula_config.threshold = 1;
            if (this.newPolicy.formula_config.token_weight == null) this.newPolicy.formula_config.token_weight = 0.5;
            if (this.newPolicy.formula_config.cost_weight == null) this.newPolicy.formula_config.cost_weight = 0.5;
        },
        async createPolicy() {
            if (this.policyValidationWarning && !confirm(this.policyValidationWarning + ' Continue?')) return;
            await fetch('/admin/policies', {
                method: 'POST',
                headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(this.newPolicy)
            });
            this.newPolicy = { id: '', name: '', limit_type: 'token', scope_period: 'monthly', daily_token_limit: 50000, monthly_token_limit: 1000000, daily_cost_limit: 0, monthly_cost_limit: 0, token_limit: 1000000, cost_limit: 0, formula_kind: 'max_ratio', formula_config: { threshold: 1, token_weight: 0.5, cost_weight: 0.5 }, allowed_models: '*' };
            this.policyPreview.result = null;
            await this.refreshAll();
        },
        async previewPolicy() {
            const response = await fetch('/admin/policies/preview', {
                method: 'POST',
                headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ policy: this.newPolicy, usage: this.policyPreview.usage })
            });
            this.policyPreview.result = await response.json();
        },
        async deletePolicy(id) {
            if (confirm('Delete?')) await fetch(`/admin/policies/${id}`, { method: 'DELETE', headers: { 'x-admin-key': this.adminKey } });
            await this.refreshAll();
        },
        async saveGroupPolicy() {
            await fetch('/admin/group-policies', {
                method: 'POST',
                headers: { 'x-admin-key': this.adminKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(this.newGroupPolicy)
            });
            this.newGroupPolicy = { group_name: '', policy_id: '', priority: 0 };
            await this.refreshAll();
        },
        async deleteGroupMapping(name) {
            if (!name) return;
            await fetch(`/admin/group-policies/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'x-admin-key': this.adminKey } });
            await this.refreshAll();
        },
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
        formatLimitValue(value, kind = 'token') {
            const n = Number(value || 0);
            if (n <= 0) return '∞';
            return kind === 'cost' ? `$${n.toFixed(4)}` : `${this.formatNumber(n)}`;
        },
        remainingValue(limit, used, kind = 'token') {
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
        }
    };
};
