/**
 * 点餐档案持久化
 *
 * 设计说明（重要）：MCP Token 绑定的是一个**真实麦当劳会员身份**，一人一个 Token，
 * 因此"切换人"在架构上不成立。这里做的是**同一账户下的多份点餐档案**——
 * 每份档案可以有不同的热量目标、预算、忌口和口味偏好，共享同一个会员账户。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT = () => ({
  activeId: 'p_default',
  profiles: [
    {
      id: 'p_default',
      name: '我',
      emoji: '🙂',
      budgetFen: 4000,
      maxKcal: null,
      minProtein: null,
      avoid: [],
      prefer: [],
      visitsPerMonth: 8,
      cardFeeFen: null,
      createdAt: new Date().toISOString(),
    },
  ],
});

export class ProfileStore {
  constructor(file) {
    this.file = file;
    this.data = this.#load();
  }

  #load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && Array.isArray(d.profiles) && d.profiles.length) return d;
    } catch {
      /* 首次运行 */
    }
    return DEFAULT();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    } catch {
      /* 写失败不阻断 */
    }
  }

  list() {
    return this.data;
  }

  active() {
    return this.data.profiles.find((p) => p.id === this.data.activeId) || this.data.profiles[0];
  }

  get(id) {
    return this.data.profiles.find((p) => p.id === id) || null;
  }

  upsert(patch) {
    const id = patch.id || `p_${crypto.randomBytes(4).toString('hex')}`;
    const existing = this.get(id);
    const next = {
      id,
      name: '新档案',
      emoji: '🙂',
      budgetFen: null,
      maxKcal: null,
      minProtein: null,
      avoid: [],
      prefer: [],
      visitsPerMonth: 8,
      cardFeeFen: null,
      ...(existing || {}),
      ...patch,
      id,
    };
    if (existing) Object.assign(existing, next);
    else this.data.profiles.push(next);
    this.#save();
    return next;
  }

  remove(id) {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (!this.data.profiles.length) this.data.profiles = DEFAULT().profiles;
    if (!this.data.profiles.some((p) => p.id === this.data.activeId)) {
      this.data.activeId = this.data.profiles[0].id;
    }
    this.#save();
    return this.data;
  }

  setActive(id) {
    if (this.data.profiles.some((p) => p.id === id)) {
      this.data.activeId = id;
      this.#save();
    }
    return this.data;
  }

  toConstraints(profile) {
    if (!profile) return {};
    return {
      budgetFen: profile.budgetFen ?? null,
      maxKcal: profile.maxKcal ?? null,
      minProtein: profile.minProtein ?? null,
      avoid: profile.avoid || [],
    };
  }
}

export default ProfileStore;
