'use strict';
const fs = require('node:fs');
const path = require('node:path');
const keys = new Set(['st-session', 'strength-trainer-data-v1']);

class FileStore {
  constructor(directory, io = fs) {
    this.io = io;
    this.file = path.join(directory, 'workouts.json');
    io.mkdirSync(directory, { recursive: true });
    this.data = io.existsSync(this.file) ? JSON.parse(io.readFileSync(this.file, 'utf8')) : {};
    if (!this.data || Array.isArray(this.data) || typeof this.data !== 'object' || Object.entries(this.data).some(([key, value]) => !keys.has(key) || typeof value !== 'string')) throw new Error('The local workout file is invalid. Restore a backup before continuing.');
  }
  checkKey(key) { if (!keys.has(key)) throw new Error('Unknown storage key.'); }
  getItem(key) { this.checkKey(key); return this.data[key] ?? null; }
  setItem(key, value) {
    this.checkKey(key);
    if (typeof value !== 'string') throw new Error('Invalid storage value.');
    this.write({ ...this.data, [key]: value });
  }
  removeItem(key) { this.checkKey(key); const next = { ...this.data }; delete next[key]; this.write(next); }
  commitWorkout(key, value) {
    if (key !== 'strength-trainer-data-v1' || typeof value !== 'string') throw new Error('Invalid workout data.');
    const next = { ...this.data, [key]: value };
    delete next['st-session'];
    this.write(next);
  }
  write(next) {
    const temporary = this.file + '.tmp';
    let descriptor;
    try {
      descriptor = this.io.openSync(temporary, 'w');
      this.io.writeFileSync(descriptor, JSON.stringify(next), 'utf8');
      this.io.fsyncSync(descriptor);
      this.io.closeSync(descriptor); descriptor = undefined;
      this.io.renameSync(temporary, this.file);
      this.data = next;
    } finally {
      if (descriptor !== undefined) this.io.closeSync(descriptor);
      if (this.io.existsSync(temporary)) this.io.unlinkSync(temporary);
    }
  }
}
module.exports = { FileStore };
