import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.resolve(process.argv[2] ?? path.join(root, 'config', 'monster-config-v0.7.xlsx'));
const outputPath = path.resolve(process.argv[3] ?? path.join(root, 'src', 'monsterData.generated.ts'));

const categoryMap = { 小怪: 'minor', 精英怪: 'elite', Boss: 'boss' };
const positionMap = { 前排: 'front', 后排: 'back' };
const damageMap = { 物理: 'physical', 魔法: 'magical', 固定: 'fixed', 无: 'none' };
const targetMap = { 当前前排: 'enemy_single', 随机合法单体: 'enemy_single', 敌方全体: 'enemy_all', 自身: 'self' };

function cellValue(sheet, row, column) {
  const value = sheet.getCell(row, column).value;
  if (value && typeof value === 'object') {
    if ('result' in value) return value.result;
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return value.text;
  }
  return value;
}


function xmlLocalName(name) {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}

function parseWorkbookSheets(xml) {
  const sheets = [];
  const parser = new SaxesParser();
  parser.on('opentag', (node) => {
    if (xmlLocalName(node.name) !== 'sheet') return;
    sheets.push({ name: node.attributes.name, relationId: node.attributes['r:id'] });
  });
  parser.write(xml).close();
  return sheets;
}

function parseRelationships(xml) {
  const relationships = {};
  const parser = new SaxesParser();
  parser.on('opentag', (node) => {
    if (xmlLocalName(node.name) !== 'Relationship') return;
    relationships[node.attributes.Id] = String(node.attributes.Target).replace(/^\//, '');
  });
  parser.write(xml).close();
  return relationships;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const values = [];
  let current = null;
  let readingText = false;
  const parser = new SaxesParser();
  parser.on('opentag', (node) => {
    const name = xmlLocalName(node.name);
    if (name === 'si') current = '';
    if (name === 't' && current !== null) readingText = true;
  });
  parser.on('text', (text) => {
    if (readingText && current !== null) current += text;
  });
  parser.on('closetag', (node) => {
    const name = xmlLocalName(node.name);
    if (name === 't') readingText = false;
    if (name === 'si' && current !== null) {
      values.push(current);
      current = null;
    }
  });
  parser.write(xml).close();
  return values;
}

function columnLetters(column) {
  let value = column;
  let letters = '';
  while (value > 0) {
    value -= 1;
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26);
  }
  return letters;
}

function parseWorksheet(xml, sharedStrings) {
  const cells = new Map();
  let rowCount = 0;
  let currentCell = null;
  let captureValue = false;
  const parser = new SaxesParser();
  parser.on('opentag', (node) => {
    const name = xmlLocalName(node.name);
    if (name === 'row') rowCount = Math.max(rowCount, Number(node.attributes.r ?? 0));
    if (name === 'c') {
      currentCell = { address: String(node.attributes.r), type: String(node.attributes.t ?? 'n'), valueText: '' };
    }
    if (currentCell && (name === 'v' || (name === 't' && currentCell.type === 'inlineStr'))) captureValue = true;
  });
  parser.on('text', (text) => {
    if (captureValue && currentCell) currentCell.valueText += text;
  });
  parser.on('closetag', (node) => {
    const name = xmlLocalName(node.name);
    if (name === 'v' || name === 't') captureValue = false;
    if (name !== 'c' || !currentCell) return;
    let value = currentCell.valueText;
    if (currentCell.type === 's') value = sharedStrings[Number(value)] ?? '';
    else if (currentCell.type === 'n' && value !== '') value = Number(value);
    else if (currentCell.type === 'b') value = value === '1';
    cells.set(currentCell.address, value);
    currentCell = null;
  });
  parser.write(xml).close();
  return {
    rowCount,
    getCell(row, column) {
      return { value: cells.get(columnLetters(column) + row) };
    }
  };
}

async function loadWorkbook(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const readXml = async (name, required = true) => {
    const entry = zip.file(name);
    if (!entry) {
      if (required) throw new Error('Missing XLSX entry: ' + name);
      return '';
    }
    return entry.async('string');
  };
  const workbookSheets = parseWorkbookSheets(await readXml('xl/workbook.xml'));
  const relationships = parseRelationships(await readXml('xl/_rels/workbook.xml.rels'));
  const sharedStrings = parseSharedStrings(await readXml('xl/sharedStrings.xml', false));
  const sheets = new Map();
  for (const sheet of workbookSheets) {
    const target = relationships[sheet.relationId];
    if (!target) throw new Error('Missing worksheet relationship: ' + sheet.relationId);
    sheets.set(sheet.name, parseWorksheet(await readXml(target), sharedStrings));
  }
  return { getWorksheet: (name) => sheets.get(name) };
}

function requiredMapValue(map, source, field) {
  const value = map[String(source ?? '')];
  if (!value) throw new Error(`Unknown ${field}: ${source}`);
  return value;
}

function executionOverrides(skillId) {
  if (skillId === 'SK-EW-101') {
    return {
      telegraph: {
        enabled: true,
        followupSkillId: skillId,
        targetSelection: 'random_legal_single_target',
        lockMode: 'unit',
        invalidTargetResult: 'whiff'
      }
    };
  }
  if (skillId === 'SK-EM-101') {
    return {
      status: {
        statusId: 'damage-increase',
        stacksAdded: 1,
        maxStacks: null,
        perStackValue: 0.25,
        stackingMode: 'additive',
        duration: 'battle'
      }
    };
  }
  if (skillId === 'SK-BOSS-001') return { specialEffects: ['block_player_energy'] };
  if (skillId === 'SK-BOSS-003') {
    return {
      telegraph: {
        enabled: true,
        followupSkillId: 'SK-BOSS-004',
        targetSelection: 'none',
        lockMode: 'none',
        invalidTargetResult: 'whiff'
      }
    };
  }
  if (skillId === 'SK-BOSS-004') return { specialEffects: ['apply_exposed'] };
  return {};
}

function selectionMode(skillId) {
  if (skillId === 'SK-EM-101') return 'forced_opening';
  if (skillId === 'SK-BOSS-004') return 'forced_followup';
  return 'weighted';
}

function numericPower(value) {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/);
  return match ? Math.round(Number(match[0])) : undefined;
}

function parseSkillLibrary(sheet) {
  const skills = {};
  for (let row = 5; row <= sheet.rowCount; row += 1) {
    const rawSkillId = cellValue(sheet, row, 1);
    if (!rawSkillId) continue;
    const skillId = String(rawSkillId);
    const tier = String(cellValue(sheet, row, 2) ?? '');
    const damageText = String(cellValue(sheet, row, 5) ?? '无');
    const execution = {
      damageType: requiredMapValue(damageMap, damageText, 'damage type'),
      targetRule: requiredMapValue(targetMap, cellValue(sheet, row, 6) ?? '自身', 'target rule')
    };
    const power = numericPower(cellValue(sheet, row, 7));
    if (power !== undefined && damageText !== '无') execution.power = power;
    Object.assign(execution, executionOverrides(skillId));
    skills[skillId] = {
      id: skillId,
      tier,
      name: String(cellValue(sheet, row, 3) ?? skillId),
      behaviorCategory: String(cellValue(sheet, row, 4) ?? ''),
      cooldown: Number(cellValue(sheet, row, 8) ?? 0),
      isBasicAttack: tier === '普攻',
      execution,
      description: String(cellValue(sheet, row, 9) ?? '')
    };
  }
  return skills;
}

function parseMonsters(sheet, skills) {
  const monsters = {};
  for (let start = 4; start <= sheet.rowCount; start += 16) {
    const rawMonsterId = cellValue(sheet, start + 1, 2);
    if (!rawMonsterId) continue;
    const monsterId = String(rawMonsterId);
    const loadout = [];
    for (let row = start + 4; row < Math.min(start + 14, sheet.rowCount + 1); row += 1) {
      const rawSkillId = cellValue(sheet, row, 11);
      if (!rawSkillId) continue;
      const skillId = String(rawSkillId);
      if (!skills[skillId]) throw new Error(`Unknown skill ${skillId} in monster ${monsterId}`);
      loadout.push({
        skillId,
        weight: Number(cellValue(sheet, row, 18) ?? 0),
        selectionMode: selectionMode(skillId)
      });
    }
    monsters[monsterId] = {
      id: monsterId,
      name: String(cellValue(sheet, start + 1, 5) ?? monsterId),
      level: Number(cellValue(sheet, start + 1, 8) ?? 1),
      category: requiredMapValue(categoryMap, cellValue(sheet, start + 6, 2), 'monster category'),
      defaultPosition: requiredMapValue(positionMap, cellValue(sheet, start + 6, 5), 'default position'),
      coefficients: {
        physicalAttack: Number(cellValue(sheet, start + 4, 2) ?? 0),
        physicalDefense: Number(cellValue(sheet, start + 4, 3) ?? 0),
        magicAttack: Number(cellValue(sheet, start + 4, 4) ?? 0),
        magicDefense: Number(cellValue(sheet, start + 4, 5) ?? 0),
        speed: Number(cellValue(sheet, start + 4, 6) ?? 0)
      },
      baseHp: Number(cellValue(sheet, start + 4, 7) ?? 0),
      skills: loadout
    };
  }
  return monsters;
}

const workbook = await loadWorkbook(inputPath);
const skillSheet = workbook.getWorksheet('技能库');
const monsterSheet = workbook.getWorksheet('怪物批量配置');
if (!skillSheet || !monsterSheet) throw new Error('Workbook must contain 技能库 and 怪物批量配置 worksheets.');

const skills = parseSkillLibrary(skillSheet);
const monsters = parseMonsters(monsterSheet, skills);
const output = [
  '// Generated by scripts/import-monsters.mjs. Do not edit by hand.',
  "import type { MonsterDefinition, MonsterSkillDefinition } from './monsterTypes';",
  '',
  `export const MONSTER_SKILLS: Record<string, MonsterSkillDefinition> = ${JSON.stringify(skills, null, 2)};`,
  '',
  `export const MONSTERS: Record<string, MonsterDefinition> = ${JSON.stringify(monsters, null, 2)};`,
  ''
].join('\n');
await fs.writeFile(outputPath, output, 'utf8');
console.log(`Imported ${Object.keys(monsters).length} monsters and ${Object.keys(skills).length} skills -> ${outputPath}`);
