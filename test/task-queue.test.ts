import { dirname, resolve } from 'path'
import { Tinypool, Task, TaskQueue } from 'tinypool'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('will put items into a task queue until they can run', async () => {
  const pool = new Tinypool({
    filename: resolve(__dirname, 'fixtures/wait-for-notify.js'),
    minThreads: 2,
    maxThreads: 3,
  })
  expect(pool.threads.length).toBe(2)
  expect(pool.queueSize).toBe(0)

  const buffers = [
    new Int32Array(new SharedArrayBuffer(4)),
    new Int32Array(new SharedArrayBuffer(4)),
    new Int32Array(new SharedArrayBuffer(4)),
    new Int32Array(new SharedArrayBuffer(4)),
  ]

  const results = []

  results.push(pool.run(buffers[0]))
  expect(pool.threads.length).toBe(2)
  expect(pool.queueSize).toBe(0)

  results.push(pool.run(buffers[1]))
  expect(pool.threads.length).toBe(2)
  expect(pool.queueSize).toBe(0)

  results.push(pool.run(buffers[2]))
  expect(pool.threads.length).toBe(3)
  expect(pool.queueSize).toBe(0)

  results.push(pool.run(buffers[3]))
  expect(pool.threads.length).toBe(3)
  expect(pool.queueSize).toBe(1)

  for (const buffer of buffers) {
    Atomics.store(buffer, 0, 1)
    Atomics.notify(buffer, 0, 1)
  }

  await results[0]
  expect(pool.queueSize).toBe(0)

  await Promise.all(results)
})

test('will reject items over task queue limit', async () => {
  const pool = new Tinypool({
    filename: resolve(__dirname, 'fixtures/eval.js'),
    minThreads: 0,
    maxThreads: 1,
    maxQueue: 2,
  })

  expect(pool.threads.length).toBe(0)
  expect(pool.queueSize).toBe(0)

  expect(pool.run('while (true) {}')).rejects.toThrow(
    /Terminating worker thread/
  )
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  expect(pool.run('while (true) {}')).rejects.toThrow(
    /Terminating worker thread/
  )
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(1)

  expect(pool.run('while (true) {}')).rejects.toThrow(
    /Terminating worker thread/
  )
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(2)

  expect(pool.run('while (true) {}')).rejects.toThrow(/Task queue is at limit/)
  await pool.destroy()
})

test('will reject items when task queue is unavailable', async () => {
  const pool = new Tinypool({
    filename: resolve(__dirname, 'fixtures/eval.js'),
    minThreads: 0,
    maxThreads: 1,
    maxQueue: 0,
  })

  expect(pool.threads.length).toBe(0)
  expect(pool.queueSize).toBe(0)

  expect(pool.run('while (true) {}')).rejects.toThrow(
    /Terminating worker thread/
  )
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  expect(pool.run('while (true) {}')).rejects.toThrow(
    /No task queue available and all Workers are busy/
  )
  await pool.destroy()
})

test('will reject items when task queue is unavailable (fixed thread count)', async () => {
  const pool = new Tinypool({
    filename: resolve(__dirname, 'fixtures/eval.js'),
    minThreads: 1,
    maxThreads: 1,
    maxQueue: 0,
  })

  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  expect(pool.run('while (true) {}')).rejects.toThrow(
    /Terminating worker thread/
  )
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  expect(pool.run('while (true) {}')).rejects.toThrow(
    /No task queue available and all Workers are busy/
  )
  await pool.destroy()
})

test('tasks can share a Worker if requested (both tests blocking)', async () => {
  const pool = new Tinypool({
    filename: resolve(__dirname, 'fixtures/wait-for-notify.js'),
    minThreads: 0,
    maxThreads: 1,
    maxQueue: 0,
    concurrentTasksPerWorker: 2,
  })

  expect(pool.threads.length).toBe(0)
  expect(pool.queueSize).toBe(0)

  expect(
    pool.run(new Int32Array(new SharedArrayBuffer(4)))
  ).rejects.toBeTruthy()
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  expect(
    pool.run(new Int32Array(new SharedArrayBuffer(4)))
  ).rejects.toBeTruthy()
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  await pool.destroy()
})

test('tasks can share a Worker if requested (both tests finish)', async () => {
  const pool = new Tinypool({
    filename: resolve(__dirname, 'fixtures/wait-for-notify.js'),
    minThreads: 1,
    maxThreads: 1,
    maxQueue: 0,
    concurrentTasksPerWorker: 2,
  })

  const buffers = [
    new Int32Array(new SharedArrayBuffer(4)),
    new Int32Array(new SharedArrayBuffer(4)),
  ]

  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  const firstTask = pool.run(buffers[0])
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  const secondTask = pool.run(buffers[1])
  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)

  Atomics.store(buffers[0] as any, 0, 1)
  Atomics.store(buffers[1] as any, 0, 1)
  Atomics.notify(buffers[0] as any, 0, 1)
  Atomics.notify(buffers[1] as any, 0, 1)
  Atomics.wait(buffers[0] as any, 0, 1)
  Atomics.wait(buffers[1] as any, 0, 1)

  await firstTask
  expect(buffers[0][0]).toBe(-1)
  await secondTask
  expect(buffers[1][0]).toBe(-1)

  expect(pool.threads.length).toBe(1)
  expect(pool.queueSize).toBe(0)
})

test('custom task queue works', async () => {
  let sizeCalled: boolean = false
  let shiftCalled: boolean = false
  let pushCalled: boolean = false

  class CustomTaskPool implements TaskQueue {
    tasks: Task[] = []

    get size(): number {
      sizeCalled = true
      return this.tasks.length
    }

    shift(): Task | null {
      shiftCalled = true
      return this.tasks.length > 0 ? (this.tasks.shift() as Task) : null
    }

    push(task: Task): void {
      pushCalled = true
      this.tasks.push(task)

      expect(Tinypool.queueOptionsSymbol in task).toBeTruthy()
      if ((task as any).task.a === 3) {
        expect(task[Tinypool.queueOptionsSymbol]).toBeNull()
      } else {
        expect(task[Tinypool.queueOptionsSymbol].option).toEqual(
          (task as any).task.a
        )
      }
    }

    remove(task: Task): void {
      const index = this.tasks.indexOf(task)
      this.tasks.splice(index, 1)
    }
  }

  const pool = new Tinypool({
    filename: resolve(__dirname, 'fixtures/eval.js'),
    taskQueue: new CustomTaskPool(),
    // Setting maxThreads low enough to ensure we queue
    maxThreads: 1,
    minThreads: 1,
  })

  function makeTask(task, option) {
    return { ...task, [Tinypool.queueOptionsSymbol]: { option } }
  }

  const ret = await Promise.all([
    pool.run(makeTask({ a: 1 }, 1)),
    pool.run(makeTask({ a: 2 }, 2)),
    pool.run({ a: 3 }), // No queueOptionsSymbol attached
  ])

  expect(ret[0].a).toBe(1)
  expect(ret[1].a).toBe(2)
  expect(ret[2].a).toBe(3)

  expect(sizeCalled).toBeTruthy()
  expect(pushCalled).toBeTruthy()
  expect(shiftCalled).toBeTruthy()
})
