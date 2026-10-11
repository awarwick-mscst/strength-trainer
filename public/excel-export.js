'use strict';
// Small, dependency-free OOXML workbook writer. ZIP entries are stored uncompressed.
(function (root) {
  const encoder = new TextEncoder();
  const xml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ -1) >>> 0;
  }
  function zip(files) {
    const parts = [], directory = [];
    let offset = 0, directorySize = 0;
    for (const [filename, text] of Object.entries(files)) {
      const name = encoder.encode(filename), bytes = encoder.encode(text), crc = crc32(bytes);
      const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(12, 33, true);
      h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
      const entry = new Uint8Array(46 + name.length), d = new DataView(entry.buffer);
      d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(14, 33, true);
      d.setUint32(16, crc, true); d.setUint32(20, bytes.length, true); d.setUint32(24, bytes.length, true); d.setUint16(28, name.length, true); d.setUint32(42, offset, true); entry.set(name, 46);
      parts.push(header, bytes); directory.push(entry); offset += header.length + bytes.length; directorySize += entry.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, directory.length, true); e.setUint16(10, directory.length, true); e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
    const result = new Uint8Array(offset + directorySize + end.length);
    let cursor = 0;
    for (const part of [...parts, ...directory, end]) { result.set(part, cursor); cursor += part.length; }
    return result;
  }
  function column(index) {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
  }
  function sheet(rows) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="12" width="20" customWidth="1"/></cols><sheetData>' + rows.map((row, i) => `<row r="${i + 1}">` + row.map((v, j) => {
      const ref = column(j) + (i + 1);
      return typeof v === 'number' && Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v ?? '')}</t></is></c>`;
    }).join('') + '</row>').join('') + '</sheetData></worksheet>';
  }
  function createWorkbook(state, history) {
    const workouts = [['Workout ID', 'Date', 'Workout', 'Lift', 'Weight (lb)', 'Set 1 reps', 'Set 2 reps', 'Set 3 reps', 'Set 4 reps', 'Set 5 reps', 'Total reps', 'All sets complete']];
    workouts[0].push('Workout duration (seconds)', 'Started at', 'Finished at', 'Average heart rate (bpm)', 'Minimum heart rate (bpm)', 'Maximum heart rate (bpm)', 'Heart-rate readings', 'Heart-rate source');
    for (const w of history.slice().reverse()) for (const e of w.exercises) workouts.push([w.id, w.date, w.type, e.label, e.weight, ...e.reps, e.reps.reduce((a, b) => a + b, 0), e.reps.every(r => r >= 5) ? 'Yes' : 'No', w.durationSeconds ?? '', w.startedAt ?? '', w.finishedAt ?? '', w.heartRate?.averageBpm ?? '', w.heartRate?.minBpm ?? '', w.heartRate?.maxBpm ?? '', w.heartRate?.sampleCount ?? '', w.heartRate ? 'Fitbit / Google Health (synced)' : '']);
    const weights = [['Lift', 'Next weight (lb)', 'Consecutive misses'], ...Object.values(state.lifts).map(l => [l.label, l.weight, l.failCount])];
    const settings = [['Setting', 'Value'], ['Workouts per week', state.daysPerWeek], ['Next workout', state.nextWorkout.type], ['Units', 'lb'], ['Exported at', new Date().toISOString()]];
    const sheets = ['Workouts', 'Current weights', 'Settings'];
    const prefix = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const files = {
      '[Content_Types].xml': prefix + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>',
      '_rels/.rels': prefix + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': prefix + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': prefix + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>',
      'xl/worksheets/sheet1.xml': sheet(workouts), 'xl/worksheets/sheet2.xml': sheet(weights), 'xl/worksheets/sheet3.xml': sheet(settings),
    };
    return zip(files);
  }
  root.StrengthExcel = { createWorkbook };
  if (typeof module !== 'undefined') module.exports = root.StrengthExcel;
})(globalThis);
