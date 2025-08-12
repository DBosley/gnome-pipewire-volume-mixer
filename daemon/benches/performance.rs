use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use pipewire_volume_mixer_daemon::cache::{AppInfo, AudioCache, SinkInfo};
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio::sync::RwLock;

fn benchmark_cache_operations(c: &mut Criterion) {
    let mut group = c.benchmark_group("cache_operations");

    // Benchmark single sink update
    group.bench_function("single_sink_update", |b| {
        let cache = AudioCache::new();
        let sink = SinkInfo { id: 1, name: "Test".to_string(), volume: 0.5, muted: false };

        b.iter(|| {
            cache.update_sink(black_box("Test".to_string()), black_box(sink.clone()));
        });
    });

    // Benchmark single app update
    group.bench_function("single_app_update", |b| {
        let cache = AudioCache::new();
        let app = AppInfo {
            display_name: "Firefox".to_string(),
            binary_name: "firefox".to_string(),
            current_sink: "Media".to_string(),
            active: true,
            sink_input_ids: vec![1, 2, 3],
            inactive_since: None,
        };

        b.iter(|| {
            cache.update_app(black_box("Firefox".to_string()), black_box(app.clone()));
        });
    });

    // Benchmark snapshot creation with various cache sizes
    for size in [10, 50, 100, 500].iter() {
        group.throughput(Throughput::Elements(*size as u64));
        group.bench_with_input(BenchmarkId::new("snapshot_creation", size), size, |b, &size| {
            let cache = AudioCache::new();

            // Populate cache
            for i in 0..size {
                cache.update_sink(
                    format!("Sink_{i}"),
                    SinkInfo { id: i as u32, name: format!("Sink_{i}"), volume: 0.5, muted: false },
                );

                if i < size / 2 {
                    cache.update_app(
                        format!("App_{i}"),
                        AppInfo {
                            display_name: format!("App_{i}"),
                            binary_name: format!("app_{i}"),
                            current_sink: "Game".to_string(),
                            active: true,
                            sink_input_ids: vec![i as u32],
                            inactive_since: None,
                        },
                    );
                }
            }

            b.iter(|| {
                black_box(cache.get_snapshot());
            });
        });
    }

    group.finish();
}

fn benchmark_concurrent_access(c: &mut Criterion) {
    let mut group = c.benchmark_group("concurrent_access");
    let runtime = Runtime::new().unwrap();

    // Benchmark concurrent reads
    group.bench_function("concurrent_reads", |b| {
        let cache = Arc::new(RwLock::new(AudioCache::new()));

        // Pre-populate
        runtime.block_on(async {
            let cache_write = cache.write().await;
            for i in 0..100 {
                cache_write.update_sink(
                    format!("Sink_{i}"),
                    SinkInfo { id: i, name: format!("Sink_{i}"), volume: 0.5, muted: false },
                );
            }
        });

        b.to_async(&runtime).iter(|| async {
            let mut handles = vec![];
            for _ in 0..10 {
                let cache_clone = cache.clone();
                let handle = tokio::spawn(async move {
                    let cache_read = cache_clone.read().await;
                    black_box(cache_read.get_snapshot());
                });
                handles.push(handle);
            }

            for handle in handles {
                handle.await.unwrap();
            }
        });
    });

    // Benchmark mixed read/write operations
    group.bench_function("mixed_read_write", |b| {
        let cache = Arc::new(RwLock::new(AudioCache::new()));

        b.to_async(&runtime).iter(|| async {
            let mut handles = vec![];

            // Readers
            for _ in 0..5 {
                let cache_clone = cache.clone();
                let handle = tokio::spawn(async move {
                    let cache_read = cache_clone.read().await;
                    black_box(cache_read.get_snapshot());
                });
                handles.push(handle);
            }

            // Writers
            for i in 0..5 {
                let cache_clone = cache.clone();
                let handle = tokio::spawn(async move {
                    let cache_write = cache_clone.write().await;
                    cache_write.update_sink(
                        format!("Sink_{i}"),
                        SinkInfo { id: i, name: format!("Sink_{i}"), volume: 0.5, muted: false },
                    );
                });
                handles.push(handle);
            }

            for handle in handles {
                handle.await.unwrap();
            }
        });
    });

    group.finish();
}

fn benchmark_memory_operations(c: &mut Criterion) {
    let mut group = c.benchmark_group("memory_operations");

    // Benchmark generation increment
    group.bench_function("generation_increment", |b| {
        let cache = AudioCache::new();
        b.iter(|| {
            cache.increment_generation();
        });
    });

    // Benchmark cleanup operation
    group.bench_function("cleanup_inactive_apps", |b| {
        let cache = AudioCache::new();

        // Add 100 inactive apps
        for i in 0..100 {
            cache.update_app(
                format!("InactiveApp_{i}"),
                AppInfo {
                    display_name: format!("InactiveApp_{i}"),
                    binary_name: format!("inactive_{i}"),
                    current_sink: "Game".to_string(),
                    active: false,
                    sink_input_ids: vec![],
                    inactive_since: Some(
                        std::time::Instant::now() - std::time::Duration::from_secs(400),
                    ),
                },
            );
        }

        // Add 10 active apps
        for i in 0..10 {
            cache.update_app(
                format!("ActiveApp_{i}"),
                AppInfo {
                    display_name: format!("ActiveApp_{i}"),
                    binary_name: format!("active_{i}"),
                    current_sink: "Media".to_string(),
                    active: true,
                    sink_input_ids: vec![i],
                    inactive_since: None,
                },
            );
        }

        b.iter(|| {
            black_box(cache.cleanup_inactive_apps(300));
        });
    });

    group.finish();
}

fn benchmark_routing_operations(c: &mut Criterion) {
    let mut group = c.benchmark_group("routing_operations");

    // Benchmark routing rule insertion
    group.bench_function("routing_rule_insert", |b| {
        let cache = AudioCache::new();
        let mut counter = 0;

        b.iter(|| {
            cache
                .routing_rules
                .insert(black_box(format!("App_{counter}")), black_box("Media".to_string()));
            counter += 1;
        });
    });

    // Benchmark routing rule lookup
    group.bench_function("routing_rule_lookup", |b| {
        let cache = AudioCache::new();

        // Pre-populate with routing rules
        for i in 0..1000 {
            cache
                .routing_rules
                .insert(format!("App_{i}"), ["Game", "Chat", "Media"][i % 3].to_string());
        }

        b.iter(|| {
            for i in 0..100 {
                black_box(cache.routing_rules.get(&format!("App_{}", i % 1000)));
            }
        });
    });

    group.finish();
}

fn benchmark_wine_app_detection(c: &mut Criterion) {
    let mut group = c.benchmark_group("wine_app_detection");

    // Benchmark the logic for determining display names for Wine apps
    group.bench_function("wine_name_processing", |b| {
        let test_cases = vec![
            ("Elite Dangerous", "wine64-preloader"),
            ("", "wine64-preloader"),
            ("wine", "notepad.exe"),
            ("WINE", "game.exe"),
            ("Steam Game", "wine64-preloader"),
        ];

        b.iter(|| {
            for (app_name, binary_name) in &test_cases {
                // Simulate the name processing logic
                let final_name = if !app_name.is_empty()
                    && !app_name.contains("preloader")
                    && !app_name.contains("WINE")
                    && *app_name != "wine"
                    && *app_name != "wine64"
                {
                    app_name.to_string()
                } else {
                    // Capitalize first letter of binary name
                    let cleaned = binary_name.trim_end_matches(".exe");
                    let mut chars = cleaned.chars();
                    match chars.next() {
                        None => String::new(),
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    }
                };
                black_box(final_name);
            }
        });
    });

    group.finish();
}

criterion_group!(
    benches,
    benchmark_cache_operations,
    benchmark_concurrent_access,
    benchmark_memory_operations,
    benchmark_routing_operations,
    benchmark_wine_app_detection
);
criterion_main!(benches);
