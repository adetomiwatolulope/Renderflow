-- JobOutput: the key on a job's output, used to make a repeated execution safe
-- (owner's Step 5). One output per job, enforced by the unique constraint.
--
-- Only a URL reference is stored. The bytes never enter the database
-- (PR-TECH-007 / PR-JOB-009).
--
-- Generated with `prisma migrate diff` from the pre-change schema, so it is an
-- additive migration: nothing is dropped, no existing column is altered, and no
-- change is lossy.

-- CreateTable
CREATE TABLE "job_outputs" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_outputs_jobId_key" ON "job_outputs"("jobId");

-- AddForeignKey
ALTER TABLE "job_outputs" ADD CONSTRAINT "job_outputs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
