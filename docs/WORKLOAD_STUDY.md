# Workload / Capacity Study

The optional workload study records passive daily workload facts and ticket lifecycle metrics so an institution can evaluate capacity using its own history instead of fixed assumptions.

Configure:

- `CONFIG.WORKLOAD_STUDY_SNAPSHOT_HOUR`;
- `CONFIG.WORKLOAD_STUDY_BASELINE_START`;
- size weights in `CONFIG.WORKLOAD_SIZE_WEIGHTS` if your size model differs.

For an existing installation that predates the workload tables, run `migrateWorkloadStudy()`. For a fresh installation, `setup()` creates the schema.

Do not copy another institution's baseline date or infer that its XS/S/M/L/XL time expectations match yours. Customize size guidance and allow your own data to establish norms.
