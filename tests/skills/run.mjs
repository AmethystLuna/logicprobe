// Skill frontmatter guard.
//
// The DSH skill catalog renders `description` ONLY (not `whenToUse`) and truncates it:
// dsh-tool-skill has `DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500` and
// `catalogDescription()` does `slice(0, maxLength - 3) + "..."` past that. So an
// over-long description is not merely long — its tail is invisible at the exact moment
// the model decides whether to load the skill. That is how the UML trigger went missing
// from the logicprobe catalog entry while it sat at the end of a 1595-character string.
//
// This test is the number, not an impression: it renders each description the way the
// catalog does, fails when anything would be cut, and requires the decision-critical
// trigger words to survive inside the visible budget.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** dsh-tool-skill: DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH (catalogDescriptionMaxLength). */
const CATALOG_DESCRIPTION_MAX_LENGTH = 500

/** Trigger words that must survive inside the catalog budget: the use cases the skill exists for. */
const REQUIRED_TRIGGERS = {
  // The entry point: broad intent, the doctrine, and the route to each domain skill.
  logicprobe: ['Use when', 'verify', 'file:line', 'S1-S8', 'logicprobe-uml', 'logicprobe-concurrency', 'logicprobe-datamodel'],
  'logicprobe-uml': ['Use when', 'diagram', 'round-trip', 'refused', 'logicprobe skill'],
  'logicprobe-concurrency': ['Use when', 'thread-safe', 'ISR-safe', 'does not prove', 'logicprobe skill'],
  'logicprobe-datamodel': ['Use when', 'migration', 'data invariants', 'rollback', 'logicprobe-uml'],
  // The architecture/dependency domain: the intent ("review this architecture") must
  // reach this skill, and the description must not promise more than the checks do.
  'logicprobe-structure': ['Use when', 'architecture', 'dependency', 'cycle', 'layer', 'logicprobe skill'],
}

const skillsRoot = fileURLToPath(new URL('../../skills/', import.meta.url))
let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log('PASS', name)
  } catch (error) {
    failures += 1
    console.log('FAIL', name, '-', error instanceof Error ? error.message : String(error))
  }
}

/** The exact projection dsh-tool-skill applies before rendering a catalog line. */
function catalogDescription(value) {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= CATALOG_DESCRIPTION_MAX_LENGTH
    ? normalized
    : normalized.slice(0, CATALOG_DESCRIPTION_MAX_LENGTH - 3) + '...'
}

function readFrontmatter(file) {
  const raw = readFileSync(file, 'utf8')
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (block === null) throw new Error('no frontmatter block')
  const name = /^name:\s*(\S+)\s*$/m.exec(block[1])
  const description = /^description:\s*"([\s\S]*?)"\s*$/m.exec(block[1])
  if (name === null) throw new Error('no name field')
  if (description === null) throw new Error('no quoted description field')
  return { name: name[1], description: description[1] }
}

const skills = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

if (skills.length === 0) throw new Error('no skills found under skills/')

for (const directory of skills) {
  const file = join(skillsRoot, directory, 'SKILL.md')
  let frontmatter
  try {
    frontmatter = readFrontmatter(file)
  } catch (error) {
    failures += 1
    console.log('FAIL frontmatter ' + directory, '-', error instanceof Error ? error.message : String(error))
    continue
  }

  check('catalog line fits the 500-char budget: ' + frontmatter.name, () => {
    const visible = catalogDescription(frontmatter.description)
    if (visible.endsWith('...')) {
      const cut = visible.slice(0, -3).length
      throw new Error(
        'description is ' + String(frontmatter.description.length) + ' chars; the catalog shows ' + String(cut) +
        ' and cuts the rest. First invisible text: "' + frontmatter.description.slice(cut, cut + 60) + '…"',
      )
    }
  })

  check('frontmatter follows the "Use when" format: ' + frontmatter.name, () => {
    if (!frontmatter.description.startsWith('Use when')) {
      throw new Error('description must open with "Use when": ' + frontmatter.description.slice(0, 40))
    }
    if (frontmatter.name !== directory) throw new Error('name "' + frontmatter.name + '" does not match directory "' + directory + '"')
  })

  const required = REQUIRED_TRIGGERS[frontmatter.name]
  if (required !== undefined) {
    check('catalog line still names every use case: ' + frontmatter.name, () => {
      const visible = catalogDescription(frontmatter.description).toLowerCase()
      const missing = required.filter((trigger) => !visible.includes(trigger.toLowerCase()))
      if (missing.length > 0) throw new Error('not visible to the model: ' + missing.join(', '))
    })
  }
}

// A registered tool must be named where the model looks for it: the core skill's tool table
// and the injected gate's tool list. A tool named in neither exists but is unreachable — it
// can only be called by accident. The reverse matters too: a name left behind after a tool
// was renamed is a dangling pointer that sends the model after something that is gone.
const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url))
const registeredTools = readdirSync(srcRoot)
  .filter((entry) => entry.endsWith('tool.ts'))
  .flatMap((entry) =>
    [...readFileSync(join(srcRoot, entry), 'utf8').matchAll(/export const [A-Z_]+TOOL_NAME = '([a-z_]+)'/g)].map((match) => match[1]),
  )
  .sort()

check('the tool inventory is discoverable, not empty', () => {
  if (registeredTools.length === 0) throw new Error('no tool names found in src/*tool.ts; this guard would pass vacuously')
})

check('every registered tool is named in the core skill and in the injected gate', () => {
  const skillText = readFileSync(join(skillsRoot, 'logicprobe', 'SKILL.md'), 'utf8')
  // The gate lives in a TypeScript template literal, so its backticks are escaped.
  const gateText = readFileSync(join(srcRoot, 'index.ts'), 'utf8').replaceAll('\\`', '`')
  const missing = registeredTools.filter(
    (name) => !skillText.includes('`' + name + '`') || !gateText.includes('`' + name + '`'),
  )
  if (missing.length > 0) throw new Error('registered but not named where the model looks: ' + missing.join(', '))
})

check('the core skill names no tool that is not registered', () => {
  const skillText = readFileSync(join(skillsRoot, 'logicprobe', 'SKILL.md'), 'utf8')
  const named = [...new Set([...skillText.matchAll(/`(logicprobe_[a-z_]+)`/g)].map((match) => match[1]))].sort()
  const unknown = named.filter((name) => !registeredTools.includes(name))
  if (unknown.length > 0) throw new Error('named but not registered: ' + unknown.join(', '))
})

// Print what the model actually receives, so a drift is readable in the test log.
console.log('\n--- catalog lines as the model sees them ---')
for (const directory of skills) {
  const frontmatter = readFrontmatter(join(skillsRoot, directory, 'SKILL.md'))
  const visible = catalogDescription(frontmatter.description)
  console.log('- `' + frontmatter.name + '`: ' + visible)
  console.log('  (' + String(frontmatter.description.length) + ' chars written, ' + String(visible.length) + ' visible, budget ' + String(CATALOG_DESCRIPTION_MAX_LENGTH) + ')')
}

if (failures > 0) {
  console.log('skill catalog checks failed:', failures)
  process.exit(1)
}
console.log('\nall skill catalog checks passed')
