import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@databricks/appkit-ui/react';

interface CreateTaskDialogProps {
  open: boolean;
  name: string;
  type: string;
  error: string | null;
  creating: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onCreate: () => void;
}

export function CreateTaskDialog(props: CreateTaskDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>Set up a shared workflow for your team.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              value={props.name}
              onChange={(event) => props.onNameChange(event.target.value)}
              placeholder="Monthly receivables"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="automation-type">Type</Label>
            <Select value={props.type} onValueChange={props.onTypeChange}>
              <SelectTrigger id="automation-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allocation_upsert">Receivables collection</SelectItem>
                <SelectItem value="vendor_bank_update">Vendor bank details</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Alert>
            <AlertDescription>
              After creation, this automation will await an administrator to bind an approved destination. You can then configure ingest and validation settings.
            </AlertDescription>
          </Alert>
          {props.error && (
            <Alert variant="destructive">
              <AlertDescription>{props.error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={props.creating} onClick={props.onCreate}>
            {props.creating ? 'Creating…' : 'Create automation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
