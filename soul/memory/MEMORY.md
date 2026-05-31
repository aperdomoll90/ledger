# What I Know About You

## Search Ledger when needed

- **System:** hooks, plugin configs, sync rules — `search_documents` with domain: system
- **Workspace:** dashboards, device registry, dev environment — `search_documents` with domain: workspace
- **Projects:** architecture, status, errors, events — `search_documents` with project name or domain: project
- **General:** personal knowledge, references, bookmarks — `search_documents` with domain: general
- **Skills:** eval results, test cases — `search_documents` with project: custom-skills

## Feedback (Behavioral Rules)
- [feedback_commit_rules.md](feedback_commit_rules.md) — short messages, no AI co-author, no committing without approval
- [feedback_interface_naming.md](feedback_interface_naming.md)
- [feedback_session_briefing.md](feedback_session_briefing.md) — invoke dawn skill at session start, never skip briefing
- [feedback_architecture_docs_structure.md](feedback_architecture_docs_structure.md) — architecture docs need visual diagrams (architecture, flowchart, sequence, ERD, DFD)
- [feedback_never_bypass_rpc.md](feedback_never_bypass_rpc.md) — never direct .update() on documents table, always use RPC functions
- [feedback_dashboard_non_negotiable.md](feedback_dashboard_non_negotiable.md) — project-status-dashboard updated every checkpoint, never optional
- [feedback_production_grade_solutions.md](feedback_production_grade_solutions.md) — always recommend industry-standard, production-grade solutions
- [feedback_explain_acronyms.md](feedback_explain_acronyms.md) — always explain acronyms and tech terms, Adrian is learning RAG
- [feedback_never_force_push_main.md](feedback_never_force_push_main.md) — NEVER amend pushed commits or force-push to main
- [feedback_guided_implementation.md](feedback_guided_implementation.md) — stop before each step, explain what/why/how, Adrian runs SQL himself
- [feedback_big_docs_wireframe_first.md](feedback_big_docs_wireframe_first.md) — for long docs, write wireframe first, fill sections second; one-shot writes loop/freeze
- [feedback_proposed_markers_concrete.md](feedback_proposed_markers_concrete.md) — {{PROPOSED}} markers must carry actual concrete starter values, never meta-descriptions like "draft at fill time"
- [feedback_doc_changes_require_approval.md](feedback_doc_changes_require_approval.md) — never modify docs without explicit approval for the specific change; proposing is not approval, wait for direct greenlight
- [feedback_decorative_dashes_in_code_comments.md](feedback_decorative_dashes_in_code_comments.md) — ─── dashes are OK inside code-block comment dividers in reference docs; CLAUDE.md ban applies to prose only
- [feedback_reference_docs_usage_annotations.md](feedback_reference_docs_usage_annotations.md) — reference docs keep short factual usage annotations (used / not-used / misused) on schema fields; not opinion bleed
- [feedback_full_words_not_acronyms.md](feedback_full_words_not_acronyms.md) — use full words (information architecture, product detail page) instead of domain acronyms (IA, PDP) in filenames and prose; universal tech acronyms (URL, API, JSON, CSV) stay
- [feedback_transient_spec_docs_local.md](feedback_transient_spec_docs_local.md) — pre-implementation specs / plans / research stay local in `~/.ledger/transient/`, never pushed to Ledger; deleted post-implementation only with explicit permission
- [feedback_test_location_exceptions.md](feedback_test_location_exceptions.md) — default is tests-next-to-source; exception for npm libraries with packaging conflicts (Ledger uses `./tests/`)
- [feedback_search_local_repo_devlogs.md](feedback_search_local_repo_devlogs.md) — search local `~/repos/*/docs/devlog.md` AND Ledger when investigating history; Ledger summaries lag behind canonical local devlogs
- [feedback_agent_state_not_project_docs.md](feedback_agent_state_not_project_docs.md) — agent session-handoff and continuity files are operational state, never project documentation; flag and exclude from inventories and client deliverables
- [feedback_class_rename_search_js_too.md](feedback_class_rename_search_js_too.md) — class renames must grep both static markup AND JS strings (className =, innerHTML, template literals); static-only sweeps leave orphan refs in JS-generated elements
- [feedback_no_px_for_sizing.md](feedback_no_px_for_sizing.md) — use rem (and svh/dvw) instead of px in CSS sizing; apply to any line touched, don't blanket-rewrite legacy mockups
- [feedback_pill_radius_only_on_squares.md](feedback_pill_radius_only_on_squares.md) — `--pill-border-radius: 50%` only renders as circle on SQUARE elements; non-square pills need literal half-height radius or a separate `--pill-shape-radius` token
- [feedback_container_query_fixed_positioning.md](feedback_container_query_fixed_positioning.md) — for drawers/overlays inside a `container-type: inline-size` wrapper, use `position: absolute` relative to a known canvas-root; browsers don't reliably contain `position: fixed` per spec
- [feedback_breakpoints_single_block.md](feedback_breakpoints_single_block.md) — all breakpoint overrides collect in ONE @media block at the bottom of a stylesheet; do NOT nest @media inside per-component BEM rules
- [feedback_no_font_shorthand.md](feedback_no_font_shorthand.md) — write font properties (font-family / -style / -weight / -size, line-height) as separate longhand declarations; do NOT use the `font:` shorthand
- [feedback_assets_image_naming.md](feedback_assets_image_naming.md) — all image assets prefixed `image-<category>-<descriptor>` (background / blog / icon / logo / portrait / product / project) for prefix-as-fake-folder in flat dirs
- [feedback_component_css_naming.md](feedback_component_css_naming.md) — `component-common-<name>.css` for reused components, `component-<scope>-<name>.css` for page-scoped; BEM blocks scope-prefix only on collision
- [feedback_derived_data_over_manual_maps.md](feedback_derived_data_over_manual_maps.md) — derive relationships via filters/transforms (`handleize`, `downcase`, system fields) instead of hardcoded lookup maps; hardcoded values only when expressing intent, not data
- [feedback_css_native_nesting.md](feedback_css_native_nesting.md) — CSS native nesting is the default for pseudo-classes, pseudo-elements, attribute/state selectors, descendants within a block; flat only for cross-component relationships and @media overrides
- [feedback_grid_layout_over_sticky.md](feedback_grid_layout_over_sticky.md) — pin drawer/dialog headers and footers via `grid-template-rows: auto 1fr auto` on the parent + `overflow-y: auto` on the middle row, never `position: sticky` on the children
- [feedback_liquid_snippet_naming.md](feedback_liquid_snippet_naming.md) — Liquid section/snippet files use bare component name (`search.liquid`), no `c-` prefix; the `c-` lives only on CSS classes inside the file
- [feedback_common_prefix_snippets.md](feedback_common_prefix_snippets.md) — snippets paired with `component-common-<name>.css` get `common-<name>-*.liquid` naming so the snippet + stylesheet are visibly part of the same component
- [feedback_svg_icons_as_assets.md](feedback_svg_icons_as_assets.md) — SVG icons live in `theme/assets/` as `.svg` files, referenced via `{{ 'name.svg' | inline_asset_content }}`; snippets are reserved for Liquid with composition/locale/logic
- [feedback_short_bullet_explanations.md](feedback_short_bullet_explanations.md) — explain code in 3-5 short bullets with a one-line "net effect" close; avoid section-by-section walkthroughs unless explicitly asked
- [feedback_css_first_over_js.md](feedback_css_first_over_js.md) — prefer CSS over JS whenever both can express the behavior; JS only for async/data work and `data-*` attribute toggles that drive CSS state
- [feedback_pseudo_elements_for_decorative_overlays.md](feedback_pseudo_elements_for_decorative_overlays.md) — backdrops, scrims, decorative shapes go on `::before`/`::after` pseudo-elements, not real DOM nodes
- [feedback_css_transition_same_positioning_model.md](feedback_css_transition_same_positioning_model.md) — CSS animations are only smooth if positioning model is identical in both states (same containing block, anchor side, position type); changing parent's position mid-animation jumps because position isn't transitionable
- [feedback_reference_html_wins.md](feedback_reference_html_wins.md) — when project designates a canonical reference HTML (CLAUDE.md section 2), mirror it instead of re-debating settled choices; short concrete questions, only about gaps
- [feedback_shopify_theme_blocks_explicit_types.md](feedback_shopify_theme_blocks_explicit_types.md) — Shopify section + block schema gotchas not caught by theme-check (lint passes, upload fails): explicit block types not "@theme" wildcards; cannot define both "presets" and "default" in the same section; `npm run dev` upload is the only reliable end-to-end check
- [feedback_shopify_block_name_25char_limit.md](feedback_shopify_block_name_25char_limit.md) — Shopify section schema `blocks[].name` is capped at 25 chars; theme-check doesn't flag it but `shopify theme push` rejects with "Invalid block: name is too long (max 25 characters)"
- [feedback_svg_composited_layer_repaint.md](feedback_svg_composited_layer_repaint.md) — SVG stroke-dashoffset updates inside a transformed/composited ancestor are skipped by Chrome's compositor (DevTools-search makes it work); two-part fix is `setAttribute` over `style.X` plus `transform: translateZ(0)` on the SVG to promote it to its own layer
- [feedback_no_obvious_comments.md](feedback_no_obvious_comments.md) — don't pad code with comments that restate what declarations / identifiers already say; only comment non-obvious WHY

## Projects
- [project_starbrite_consolidation.md](project_starbrite_consolidation.md) — Starbrite redesign consolidates instincts.starbrite.com + www.starbrite.com into one Shopify store; design system covers editorial + commerce
- [project_starbrite_folder_structure.md](project_starbrite_folder_structure.md) — Starbrite docs split by concern: base research (immutable) / client facing / internal working docs / old; raw queries live separately at ~/Documents/queries from shopify/
- [project_starbrite_client_provided_files.md](project_starbrite_client_provided_files.md) — Plytix CSV and Star Tron Brand Voice doc in base research are client-provided; treat as authoritative client inputs, not our research output
- [project_starbrite_contacts.md](project_starbrite_contacts.md) — current Starbrite POCs are Turner Burwick + Bob (since 2026-05-04); Kouri Carey no longer active; invoices stay name-free
- [project_starbrite_stores.md](project_starbrite_stores.md) — Shopify stores: Adrian's dev (perdomo-studio-dev) for development; client (starbritedev) for archive pull + eventual push, staff access pending
