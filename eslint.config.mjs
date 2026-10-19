import nodecraft from '@nodecraft/eslint-config';
import vitest from '@vitest/eslint-plugin';

const jsonIgnore = ['**/*.json'];
const withJsonIgnore = function(configs) {
	return configs.map(function(config) {
		return {
			...config,
			ignores: [...(config.ignores || []), ...jsonIgnore],
		};
	});
};

export default [
	// Global ignores
	{
		ignores: [
			'.wrangler/**',
		],
	},

	// Node + TypeScript config (typescript includes base)
	...withJsonIgnore(nodecraft.configs.node),
	...withJsonIgnore(nodecraft.configs.typescript),

	// JSON
	...nodecraft.configs.json,

	// Overrides
	{
		ignores: jsonIgnore,
		rules: {
			'n/no-unsupported-features/node-builtins': 'off',
		},
	},

	// Vitest test files
	{
		files: ['test/**/*.ts'],
		plugins: {
			vitest,
		},
		rules: {
			...vitest.configs.recommended.rules,
		},
		languageOptions: {
			globals: {
				...vitest.environments.env.globals,
			},
		},
	},
];
