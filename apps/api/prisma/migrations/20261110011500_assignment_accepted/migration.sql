-- Provider flow: a setter-APPROVED assignment becomes ACCEPTED when the
-- technician confirms the job in the Tech App.
ALTER TYPE "AssignmentStatus" ADD VALUE 'ACCEPTED';
