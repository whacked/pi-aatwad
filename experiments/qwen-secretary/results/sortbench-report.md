# SORTBENCH report

## Scope

This benchmark compares three sorting implementations on integer lists:

- **Insertion sort**: a straightforward stable, comparison-based implementation.
- **Merge sort**: an iterative bottom-up merge sort.
- **Python `sorted()`**: CPython's built-in Timsort implementation.

Each was tested with **random**, **already-sorted**, and **reversed** inputs containing 1,000, 5,000, and 20,000 integers. Insertion sort was intentionally skipped at 20,000 items because its quadratic worst-case behavior would make the benchmark unnecessarily slow.

## Methodology

The benchmark is implemented in [`bench.py`](bench.py) using only the Python standard library. The reported run used Python 3.11.2 (GCC 12.2.0) and these controls:

- deterministic seed `20250321`;
- random values include negatives and duplicates;
- sorted and reversed cases are derived from the same random list for each size;
- all algorithms return a new list, so copying and allocation are included in the timings;
- correctness is checked against `sorted()`, and each implementation is checked for input mutation;
- `time.perf_counter_ns()` supplies the timer;
- every case has an untimed warm-up;
- cyclic garbage collection is disabled only during timed batches;
- adaptive batching targets about 50 ms per sample; and
- the result is the median of seven independent samples, expressed in milliseconds per sort.

The figures describe this particular Python implementation and runtime environment. They should be treated as comparative measurements, not universal constants. Run `python3 bench.py` to reproduce the test on another machine.

## Results

**Median milliseconds per sort (lower is better):**

| Items | Input | Insertion sort | Merge sort | `sorted()` |
|---:|:---|---:|---:|---:|
| 1,000 | random | 7.303525 | 0.496367 | 0.027689 |
| 1,000 | sorted | 0.026849 | 0.402430 | 0.002938 |
| 1,000 | reversed | 16.108264 | 0.396294 | 0.011720 |
| 5,000 | random | 171.872542 | 3.088349 | 0.218560 |
| 5,000 | sorted | 0.141592 | 2.571529 | 0.019030 |
| 5,000 | reversed | 365.376250 | 2.458960 | 0.048111 |
| 20,000 | random | skipped | 14.532111 | 1.535438 |
| 20,000 | sorted | skipped | 11.628250 | 0.084245 |
| 20,000 | reversed | skipped | 11.084854 | 0.202069 |

## Analysis

### Insertion sort is highly dependent on input order

Insertion sort was excellent on already-sorted data because every element was already in place. Its work in that case is effectively linear: increasing the input from 1,000 to 5,000 items increased the median from 0.026849 ms to 0.141592 ms, about **5.3×** for **5×** as much data. On the sorted cases it was also about **15–18× faster** than the pure-Python merge sort.

That advantage disappears when elements must move. On random input, insertion sort rose from 7.303525 ms at 1,000 items to 171.872542 ms at 5,000, a **23.5×** increase. On reversed input, its worst case, it rose from 16.108264 ms to 365.376250 ms, a **22.7×** increase. Both are close to the **25×** growth expected when a quadratic algorithm receives five times as many elements.

At 5,000 items, insertion sort was about **56× slower than merge sort** on random input and **149× slower** on reversed input. Skipping its 20,000-item cases is therefore both practical and consistent with its expected complexity.

### Merge sort is predictable across input shapes

The merge-sort results varied relatively little with ordering. At 20,000 items, its medians ranged only from 11.084854 ms for reversed input to 14.532111 ms for random input. This reflects merge sort's **O(n log n)** behavior: it performs broadly similar merging work regardless of whether the original input is random, ordered, or reversed.

Scaling also follows that expectation. From 5,000 to 20,000 items, merge-sort time increased by roughly **4.5–4.7×** while the input grew by 4×. The extra factor is consistent with the logarithmic term and normal measurement effects.

Merge sort is therefore much safer than insertion sort when input order is unknown or when lists become larger. However, this implementation runs its element-by-element loops in Python, which imposes substantial interpreter overhead.

### Python's `sorted()` wins every measured case

The built-in function was the fastest result in all nine scenarios. Compared with merge sort, `sorted()` was approximately:

- **9–18× faster** on random data;
- **135–138× faster** on already-sorted data; and
- **34–55× faster** on reversed data.

Its advantage comes from two sources. First, the production implementation executes optimized low-level code rather than Python bytecode for every comparison and move. Second, Timsort detects existing ordered runs and exploits them. That adaptiveness is especially visible on already-sorted input: at 20,000 items, `sorted()` took only 0.084245 ms, compared with 1.535438 ms for random input.

Reversed data is also structured rather than random. Timsort can identify descending runs and reverse them, explaining why reversed inputs were much faster than random inputs even though they are the worst case for insertion sort.

### Memory characteristics

The algorithms also differ in how they use memory:

- **Insertion sort** is normally an in-place algorithm requiring **O(1) auxiliary working space**. In this benchmark it first copies the input so it can return a new list without mutation. Its measured API therefore uses **O(n) total additional space**, even though the sorting loop itself uses only constant extra space.
- **Merge sort** generally requires **O(n) auxiliary space** for merging. This bottom-up implementation keeps a source copy and a second list-sized destination buffer, swapping their roles after each pass. Its peak additional storage remains O(n), not O(n log n): the same buffers are reused across merge levels rather than allocating new storage at every level.
- **Python `sorted()`** returns a new list and thus necessarily allocates **O(n) space** for the result. CPython's Timsort may also allocate a temporary merge buffer proportional to the input in the worst case, so its auxiliary use is O(n); its internal run stack is much smaller. `list.sort()` would avoid the separate result-list copy, but Timsort can still require O(n) temporary merge space.

Thus insertion sort has the smallest inherent workspace when mutation is allowed, while this merge sort and the built-in can trade linear extra memory for much better performance on large, unordered inputs.

### Algorithmic complexity and implementation language both matter

The measurements illustrate two separate performance effects:

1. **Growth rate:** insertion sort's quadratic behavior dominates as unordered inputs grow, whereas merge sort and Timsort scale much better.
2. **Constant factors and runtime implementation:** even where insertion sort has favorable linear behavior on sorted data, the built-in still wins because its optimized implementation has far lower overhead. Similarly, both merge sort and `sorted()` have O(n log n) general behavior, but their absolute performance differs dramatically.

Because every function returns a new list, these timings include allocation and copying. For very fast sorted cases, that fixed work represents a meaningful portion of the measured time, but it also makes the end-to-end comparison consistent with the normal behavior of `sorted()`.

## Conclusions

- Use **Python's `sorted()`** for normal application code. It was decisively fastest for every tested size and input arrangement, and it benefits greatly from existing order.
- Use **merge sort** when implementing an algorithm for study or when its predictable O(n log n) behavior is specifically required. It handles random and reversed inputs far better than insertion sort, but a pure-Python implementation cannot approach the built-in's optimized performance.
- Use **insertion sort** only for very small inputs or narrowly controlled situations such as data that is already or nearly sorted. Its best case is strong, but random and reversed inputs expose quadratic scaling quickly.
- Input arrangement matters: sorted data is the best case for insertion sort and is also especially favorable to Timsort, while merge sort is comparatively insensitive to the initial order.

Overall, the benchmark supports the practical recommendation to prefer `sorted()` unless the purpose is explicitly educational or requires a custom sorting implementation.
