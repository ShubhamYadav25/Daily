(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.DailySync = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const keyOf = (entity, id, field) => JSON.stringify([entity, id, field]);
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const dotKey = version => version.actor + ':' + version.sequence;
    const unique = values => values.filter((value, index) => values.findIndex(other => same(value, other)) === index);

    function mergeRegister(left, right) {
        if (!left) return right;
        if (!right) return left;
        const leftIds = new Set(left.heads.map(dotKey));
        const rightIds = new Set(right.heads.map(dotKey));
        const heads = new Map();
        left.heads.forEach(version => {
            if (rightIds.has(dotKey(version)) || version.sequence > (right.clock[version.actor] || 0)) heads.set(dotKey(version), version);
        });
        right.heads.forEach(version => {
            if (leftIds.has(dotKey(version)) || version.sequence > (left.clock[version.actor] || 0)) heads.set(dotKey(version), version);
        });
        const clock = Object.assign(Object.create(null), left.clock);
        Object.entries(right.clock).forEach(([actor, sequence]) => clock[actor] = Math.max(clock[actor] || 0, sequence));
        return { clock, heads: [...heads.values()].sort((first, second) => dotKey(first).localeCompare(dotKey(second))) };
    }

    function mergeRecords(left, right) {
        const merged = { ...left };
        Object.entries(right).forEach(([key, register]) => merged[key] = mergeRegister(merged[key], register));
        return merged;
    }

    function validRecords(records) {
        if (!records || typeof records !== 'object' || Array.isArray(records)) return false;
        return Object.entries(records).every(([key, register]) => {
            let parts;
            try { parts = JSON.parse(key); } catch { return false; }
            return Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === 'string')
                && register && register.clock && typeof register.clock === 'object' && !Array.isArray(register.clock)
                && Object.values(register.clock).every(sequence => Number.isSafeInteger(sequence) && sequence > 0)
                && Array.isArray(register.heads) && register.heads.length > 0
                && register.heads.every(version => version && typeof version.actor === 'string'
                    && Number.isSafeInteger(version.sequence) && version.sequence > 0
                    && version.sequence <= (register.clock[version.actor] || 0)
                    && Object.hasOwn(version, 'value') && Array.isArray(version.previous));
        });
    }

    function flatten(snapshot) {
        const fields = new Map();
        const add = (entity, id, field, value) => fields.set(keyOf(entity, String(id), field), value ?? null);
        (snapshot.cols || []).forEach((column, position) => {
            Object.entries(column).forEach(([field, value]) => add('column', column.id, field, value));
            add('column', column.id, '__deleted', false);
            add('column', column.id, 'position', position);
        });
        Object.entries(snapshot.cards || {}).forEach(([column, cards]) => (cards || []).forEach((card, position) => {
            Object.entries(card).forEach(([field, value]) => {
                if (field !== 'comments') add('card', card.id, field, value);
            });
            (card.comments || []).forEach(comment => {
                Object.entries(comment).forEach(([field, value]) => add('comment', comment.id, field, value));
                add('comment', comment.id, 'cardId', card.id);
                add('comment', comment.id, '__deleted', false);
            });
            add('card', card.id, 'column', column);
            add('card', card.id, 'position', position);
            add('card', card.id, '__deleted', false);
        }));
        add('scratch', 'shared', 'content', snapshot.scratch || '');
        return fields;
    }

    function createEngine({ actor, records = {}, diffChars }) {
        let state = records;
        let sequence = Math.max(0, ...Object.values(state).map(register => register.clock[actor] || 0));
        const textField = key => ['task', 'content', 'label', 'text'].includes(JSON.parse(key)[2]);

        function relatedKeys(key) {
            const [entity, id] = JSON.parse(key);
            const cardIds = new Set(entity === 'card' ? [id] : []);
            if (entity === 'column') Object.keys(state).forEach(other => {
                const [type, cardId, field] = JSON.parse(other);
                if (type === 'card' && field === 'column' && inspect(other).alternatives.includes(id)) cardIds.add(cardId);
            });
            return Object.keys(state).filter(other => {
                const [type, otherId] = JSON.parse(other);
                if (type === entity && otherId === id) return true;
                if (type === 'card' && cardIds.has(otherId)) return true;
                return type === 'comment' && inspect(keyOf('comment', otherId, 'cardId')).alternatives.some(cardId => cardIds.has(cardId));
            });
        }

        function versionsFor(key) {
            return JSON.parse(key)[2] === '__deleted' ? relatedKeys(key).flatMap(other =>
                state[other].heads.map(version => JSON.stringify([other, dotKey(version)]))).sort()
                : state[key].heads.map(dotKey).sort();
        }

        function unreviewedDeletion(key, register) {
            return register.heads.some(version => version.value === true && version.resolution && relatedKeys(key).some(other =>
                other !== key && state[other].heads.some(head => head.sequence > (version.reviewed?.[other]?.[head.actor] || 0))));
        }

        function additions(base, value) {
            if (typeof base !== 'string' || typeof value !== 'string') return null;
            if (base === value) return [];
            if (value.length <= base.length) return null;
            if (value.startsWith(base)) return [{ position: base.length, text: value.slice(base.length) }];
            const changes = diffChars(base, value, { maxEditLength: value.length - base.length });
            if (!changes) return null;
            if (changes.some(change => change.removed)) return null;
            let position = 0;
            const inserts = [];
            changes.forEach(change => {
                if (change.added) inserts.push({ position, text: change.value });
                else position += change.value.length;
            });
            return inserts;
        }

        function joinedText(heads) {
            const values = unique(heads.map(version => version.value));
            if (!values.every(value => typeof value === 'string')) return null;
            if (heads.every(version => version.base == null)) return null;
            if (heads.some(version => typeof version.base === 'string' && additions(version.base, version.value) === null)) return null;
            const containing = values.find(value => values.every(other => additions(other, value) !== null));
            if (containing !== undefined) return containing;
            const base = heads[0].base;
            if (typeof base !== 'string' || !heads.every(version => version.base === base)) return null;
            const inserts = new Map();
            for (const value of values) {
                const changes = additions(base, value);
                if (!changes) return null;
                changes.forEach(change => {
                    const texts = inserts.get(change.position) || [];
                    if (!texts.includes(change.text)) texts.push(change.text);
                    inserts.set(change.position, texts);
                });
            }
            let result = '';
            for (let position = 0; position <= base.length; position++) {
                result += (inserts.get(position) || []).sort().join('');
                if (position < base.length) result += base[position];
            }
            return result;
        }

        function inspect(key, register = state[key]) {
            if (!register) return { value: null, alternatives: [], conflict: false };
            const heads = register.heads;
            const guarded = heads.some(version => version.previous.length > 0 || version.resolution);
            const alternatives = unique(heads.flatMap(version => [...version.previous, version.value]));
            const field = JSON.parse(key)[2];
            if (alternatives.length === 1) return { value: alternatives[0], alternatives, conflict: false };
            if (['createdAt', 'updatedAt', 'doneAt', 'position'].includes(field)) {
                const value = [...heads].sort((first, second) => dotKey(first).localeCompare(dotKey(second))).at(-1).value;
                return { value, alternatives: [value], conflict: false };
            }
            if (!guarded && textField(key)) {
                const value = joinedText(heads);
                if (value !== null) return { value, alternatives: [value], conflict: false };
            }
            const own = heads.filter(version => version.actor === actor).at(-1);
            const value = field === '__deleted' ? false : own ? own.value : alternatives[0];
            return { value, alternatives, conflict: true };
        }

        function write(key, value, { resolve = false, initialize = false } = {}) {
            const current = state[key];
            const inspected = inspect(key, current);
            const guarded = current && (inspected.conflict
                || (JSON.parse(key)[2] === '__deleted' && value === true)
                || (textField(key) && additions(inspected.value ?? '', value) === null));
            const previous = !resolve && guarded ? inspected.alternatives.filter(other => !same(other, value)) : [];
            sequence++;
            const register = {
                clock: Object.assign(Object.create(null), current?.clock, { [actor]: sequence }),
                heads: [{ actor, sequence, value, previous, base: initialize ? null : inspected.value, resolution: resolve,
                    ...(resolve && JSON.parse(key)[2] === '__deleted' && value === true
                        ? { reviewed: Object.fromEntries(relatedKeys(key).map(other => [other, state[other].clock])) } : {}) }]
            };
            state = { ...state, [key]: register };
            return register;
        }

        function capture(before, after) {
            const oldFields = flatten(before);
            const newFields = flatten(after);
            const changed = {};
            newFields.forEach((value, key) => {
                if (!state[key] || !same(value, oldFields.get(key))) changed[key] = write(key, value, { initialize: !state[key] });
            });
            oldFields.forEach((value, key) => {
                const [entity, id, field] = JSON.parse(key);
                if (field === '__deleted' && !newFields.has(key)) changed[key] = write(key, true);
                else if (newFields.has(keyOf(entity, id, '__deleted')) && !newFields.has(key)) changed[key] = write(key, null);
            });
            return changed;
        }

        function merge(remote) {
            if (!validRecords(remote)) throw new Error('Invalid sync records');
            const next = mergeRecords(state, remote);
            const changed = !same(state, next);
            state = next;
            return changed;
        }

        function materialize() {
            const entities = Object.fromEntries(['column', 'card', 'comment', 'scratch'].map(entity => [entity, Object.create(null)]));
            const conflicts = [];
            Object.entries(state).sort(([left], [right]) => left.localeCompare(right)).forEach(([key, register]) => {
                const [entity, id, field] = JSON.parse(key);
                if (!entities[entity]) return;
                let inspected = inspect(key, register);
                if (field === '__deleted' && inspected.value === true && unreviewedDeletion(key, register)) {
                    inspected = { value: false, alternatives: [false, true], conflict: true };
                }
                const item = entities[entity][id] ||= Object.assign(Object.create(null), { id });
                item[field] = inspected.value;
                if (inspected.conflict) conflicts.push({ key, entity, id, field, values: inspected.alternatives,
                    versions: versionsFor(key), authors: unique(register.heads.map(version => version.actor)) });
            });
            const order = (left, right) => (left.position || 0) - (right.position || 0) || left.id.localeCompare(right.id);
            const cols = Object.values(entities.column).filter(column => !column.__deleted).sort(order);
            const cards = {};
            cols.forEach(column => cards[column.id] = []);
            Object.values(entities.card).filter(card => !card.__deleted).sort(order).forEach(card => {
                if (!cards[card.column]) {
                    const hidden = entities.column[card.column];
                    if (hidden) {
                        const restored = { ...hidden, __deleted: false };
                        cols.push(restored);
                        cards[card.column] = [];
                    } else return;
                }
                card.comments = Object.values(entities.comment).filter(comment => comment.cardId === card.id && !comment.__deleted)
                    .sort((left, right) => (left.ts || 0) - (right.ts || 0));
                const column = card.column;
                delete card.column;
                cards[column].push(card);
            });
            conflicts.forEach(conflict => conflict.title = entities[conflict.entity]?.[conflict.id]?.task
                || entities[conflict.entity]?.[conflict.id]?.label || (conflict.entity === 'scratch' ? 'Scratch Pad' : conflict.id));
            Object.values(entities).forEach(bucket => Object.values(bucket).forEach(item => {
                delete item.__deleted;
                delete item.position;
            }));
            return { cols, cards, scratch: entities.scratch.shared?.content || '', conflicts };
        }

        function resolve(conflict, value) {
            const register = state[conflict.key];
            if (!register || !same(versionsFor(conflict.key), conflict.versions)) return null;
            return { [conflict.key]: write(conflict.key, value, { resolve: true }) };
        }

        return { capture, merge, materialize, resolve, getRecords: () => state, inspect };
    }

    return { createEngine, mergeRecords, validRecords };
});