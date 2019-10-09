import sysPath from 'path'
import tmp from 'tmp-promise'
import SQLite, {sql, valToSql} from './SQLite'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('valToSql', () => {
	expect(valToSql(true)).toBe('1')
	expect(valToSql(false)).toBe('0')
	expect(valToSql(0)).toBe('0')
	expect(valToSql(5.4)).toBe('5.4')
	expect(valToSql("h'i")).toBe("'h''i'")
	expect(valToSql(null)).toBe('NULL')
	expect(valToSql()).toBe('NULL')
})

test(`sql.quoteId`, () => {
	expect(sql.quoteId('a"ha"h""a a a a"')).toBe('"a""ha""h""""a a a a"""')
})
test('sql`` values', () => {
	const out = sql`values ${1}, ${'a'} bop`
	expect(out).toEqual(['values ?, ? bop', [1, 'a']])
	expect(sql`${5}`).toEqual(['?', [5]])
})
test('sql`` JSON', () => {
	const json = sql` ${'meep'}JSON, ${'moop'}JSONs, ${7}JSON`
	expect(json).toEqual([' ?, ?JSONs, ?', ['"meep"', 'moop', '7']])
})
test('sql`` ID', () => {
	const out = sql`ids ${1}ID, ${2}IDs ${'a"meep"whee'}ID`
	expect(out).toEqual(['ids "1", ?IDs "a""meep""whee"', [2]])
})
test('sql`` LIT', () => {
	const out = sql`ids ${1}LIT, ${2}LITs ${'a"meep"whee'}LIT`
	expect(out).toEqual(['ids 1, ?LITs a"meep"whee', [2]])
})

test('sql`` on DB/db/fns', async () => {
	const db = new SQLite()
	expect(typeof SQLite.sql).toBe('function')
	expect(typeof db.sql).toBe('function')
	let p
	expect(() => {
		p = db.exec`CREATE TABLE ${'foo'}ID(id BLOB);`
	}).not.toThrow()
	await expect(p).resolves.not.toThrow()
	expect(() => {
		p = db.run`INSERT INTO ${'foo'}ID VALUES (${5})`
	}).not.toThrow()
	await expect(p).resolves.not.toThrow()
	expect(() => {
		p = db.get`SELECT * FROM ${'foo'}ID WHERE ${'id'}ID = ${5}`
	}).not.toThrow()
	const row = await p
	expect(row.id).toBe(5)
	await db.close()
})

test('creates DB', async () => {
	const db = new SQLite()
	expect(db.dbP).toBeInstanceOf(Promise)
	const version = await db.get('SELECT sqlite_version()')
	expect(version['sqlite_version()']).toBeTruthy()
	expect(db.store).toEqual({})
	await db.close()
})

test('readOnly', async () => {
	const db = new SQLite({readOnly: true})
	await expect(db.get('SELECT sqlite_version()')).resolves.toBeTruthy()
	await expect(db.get('CREATE TABLE foo(id)')).rejects.toThrow(
		'SQLITE_READONLY'
	)
	await db.close()
})

test('each()', async () => {
	const db = new SQLite()
	await db.exec(`
		CREATE TABLE foo(hi NUMBER);
		INSERT INTO foo VALUES (42);
		INSERT INTO foo VALUES (43);
	`)
	const arr = []
	await db.each(`SELECT * FROM foo`, ({hi}) => arr.push(hi))
	expect(arr).toEqual([42, 43])
	await db.close()
})

test('close()', async () => {
	const db = new SQLite()
	await db.exec(`
		CREATE TABLE foo(hi NUMBER);
		INSERT INTO foo VALUES (42);
	`)
	const {hi} = await db.get(`SELECT * FROM foo`)
	expect(hi).toBe(42)
	// This clears db because it's in memory only
	await db.close()
	await db.exec(`
		CREATE TABLE foo(hi NUMBER);
		INSERT INTO foo VALUES (43);
	`)
	const {hi: hi2} = await db.get(`SELECT * FROM foo`)
	expect(hi2).toBe(43)
	await db.close()
})

test('onWillOpen', async () => {
	const fn = jest.fn()
	const db = new SQLite({
		onWillOpen: fn,
	})
	expect(fn).toHaveBeenCalledTimes(0)
	await db.open()
	expect(fn).toHaveBeenCalledTimes(1)
	await db.close()
})

describe('withTransaction', () => {
	test('works', async () => {
		const db = new SQLite()
		await db.exec`CREATE TABLE foo(hi INTEGER PRIMARY KEY, ho INT);`
		db.withTransaction(async () => {
			await wait(100)
			await db.exec`INSERT INTO foo VALUES (43, 1);`
		})
		await db.withTransaction(
			() => db.exec`UPDATE foo SET ho = 2 where hi = 43;`
		)
		expect(await db.all`SELECT * from foo`).toEqual([{hi: 43, ho: 2}])
		await db.close()
	})

	test('rollback works', async () => {
		const db = new SQLite()
		await db.exec`CREATE TABLE foo(hi INTEGER PRIMARY KEY, ho INT);`
		await expect(
			db.withTransaction(async () => {
				await db.exec`INSERT INTO foo VALUES (43, 1);`
				throw new Error('ignoreme')
			})
		).rejects.toThrow('ignoreme')
		expect(await db.all`SELECT * from foo`).toEqual([])
		await db.close()
	})

	test('emits', async () => {
		const db = new SQLite()
		const begin = jest.fn()
		const end = jest.fn()
		const rollback = jest.fn()
		const fnl = jest.fn()
		db.on('begin', begin)
		db.on('end', end)
		db.on('rollback', rollback)
		db.on('finally', fnl)
		await db.withTransaction(() => {
			expect(begin).toHaveBeenCalled()
			expect(rollback).not.toHaveBeenCalled()
			expect(end).not.toHaveBeenCalled()
			expect(fnl).not.toHaveBeenCalled()
		})
		expect(begin).toHaveBeenCalledTimes(1)
		expect(rollback).not.toHaveBeenCalled()
		expect(end).toHaveBeenCalledTimes(1)
		expect(fnl).toHaveBeenCalledTimes(1)
		await db
			.withTransaction(() => {
				expect(begin).toHaveBeenCalledTimes(2)
				expect(rollback).not.toHaveBeenCalled()
				expect(end).toHaveBeenCalledTimes(1)
				expect(fnl).toHaveBeenCalledTimes(1)
				// eslint-disable-next-line no-throw-literal
				throw 'foo'
			})
			.catch(e => {
				if (e !== 'foo') throw e
				expect(rollback).toHaveBeenCalledTimes(1)
				expect(end).toHaveBeenCalledTimes(1)
				expect(fnl).toHaveBeenCalledTimes(2)
			})
	})
})

test('dataVersion', () =>
	tmp.withDir(
		async ({path: dir}) => {
			const file = sysPath.join(dir, 'db')
			const db1 = new SQLite({file})
			const db2 = new SQLite({file})
			const v1 = await db1.dataVersion()
			const v2 = await db2.dataVersion()
			await db1.exec`SELECT 1;`
			expect(await db1.dataVersion()).toBe(v1)
			expect(await db2.dataVersion()).toBe(v2)
			await db1.exec`CREATE TABLE foo(hi INTEGER PRIMARY KEY, ho INT);`
			expect(await db1.dataVersion()).toBe(v1)
			const v2b = await db2.dataVersion()
			expect(v2b).toBeGreaterThan(v2)
			await db2.exec`INSERT INTO foo VALUES (43, 1);`
			expect(await db1.dataVersion()).toBeGreaterThan(v1)
			expect(await db2.dataVersion()).toBe(v2b)
			await db1.close()
			await db2.close()
		},
		{unsafeCleanup: true}
	))

test('userVersion', async () => {
	const db = new SQLite()
	await expect(db.userVersion()).resolves.toBe(0)
	await expect(db.userVersion(5)).resolves.toBe()
	await expect(db.userVersion()).resolves.toBe(5)
})

test('open: errors with filename', async () => {
	const db = new SQLite({file: '/oienu/ieoienien'})
	await expect(db._openDB()).rejects.toThrow('/oienu/ieoienien')
})

test('SQLite methods: errors with filename', async () => {
	const db = new SQLite()
	await expect(db.run('bad sql haha')).rejects.toThrow(':memory:')
	await expect(db.get('bad sql haha')).rejects.toThrow(':memory:')
	await expect(db.all('bad sql haha')).rejects.toThrow(':memory:')
	await expect(db.exec('bad sql haha')).rejects.toThrow(':memory:')
	await expect(db.each('bad sql haha')).rejects.toThrow(':memory:')
	await expect(db.prepare('bad sql haha').get()).rejects.toThrow(':memory:')
	await db.close()
})

test('vacuum', async () => {
	const db = new SQLite({autoVacuum: true})
	expect(await db.get('PRAGMA auto_vacuum')).toHaveProperty('auto_vacuum', 2)
	expect(db._vacuumToken).toBeDefined()
	await db.close()
	expect(db._vacuumToken).toBeFalsy()
	const db2 = new SQLite()
	await db2.open()
	expect(await db2.get('PRAGMA auto_vacuum')).toHaveProperty('auto_vacuum', 0)
})
