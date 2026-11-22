  // ---------- Force all free-text inputs to uppercase as the person types ----------
  // Delegated on document so it also covers inputs created later (IT Entry's
  // per-batch PLU / Material Document / Key In By fields). Password fields
  // and number fields are untouched.
  document.addEventListener('input', function(e){
    var el = e.target;
    if(el.tagName === 'INPUT' && el.type === 'text'){
      var start = el.selectionStart, end = el.selectionEnd;
      var upper = el.value.toUpperCase();
      if(upper !== el.value){
        el.value = upper;
        if(document.activeElement === el && start !== null){
          el.setSelectionRange(start, end);
        }
      }
    }
  });

  // ================= CROSS-ORIGIN API BRIDGE =================
  // This page is hosted on GitHub Pages, a different domain from the Apps
  // Script backend, so google.script.run (which only exists on
  // script.google.com) is not available here. Instead we call the deployed
  // Web App URL directly with fetch(). Read-only calls go via GET
  // (?action=...), anything that writes data goes via POST with a JSON body.
  //
  // IMPORTANT: if you redeploy the Apps Script project and get a NEW /exec
  // URL, update EXEC_URL below to match.
  var EXEC_URL = 'https://script.google.com/macros/s/AKfycbwg2_9PLumzPLimQEV7-Ym-UvEXPhlyvqGLzzl8T24WLUnDWHw-j3OPrBkOphJGm52l/exec';

  // ================= SUPABASE CLIENT =================
  // Migration in progress: functions are being swapped from the Apps Script
  // bridge above (apiGet/apiPost) to Supabase one at a time. Using "sb" as
  // the variable name to avoid colliding with the library's own
  // window.supabase namespace.
  var SUPABASE_URL = 'https://naqswcyosmonfidsmyik.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_mqD4FqSihVWku1hOC6mClg_TG3CQcIT';
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  function apiGet(action) {
    return fetch(EXEC_URL + '?action=' + encodeURIComponent(action))
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || 'Request failed.');
        return json.data;
      });
  }

  function apiPost(action, params) {
    // Content-Type "text/plain" avoids a CORS preflight request, which
    // Apps Script Web Apps don't handle. We still send JSON — Apps Script's
    // doPost() parses e.postData.contents regardless of the declared type.
    return fetch(EXEC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, params: params })
    })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!json.success) throw new Error(json.error || 'Request failed.');
        return json.data;
      });
  }

  // ---------- Supabase: getMasterlist ----------
  // Reads the masterlist table (plu_code, material, description, uom) and
  // maps it into the same shape lookupPlu()/renderPendingAddPreview()
  // already expect ({plu, description, material, uom}), so nothing else
  // in the app needs to change for this swap.
  function getMasterlistFromSupabase(){
    return sb.from('masterlist').select('*')
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return res.data.map(function(row){
          return { plu: row.plu_code, description: row.description, material: row.material, uom: row.uom, category: row.category };
        });
      });
  }

  // ---------- Supabase: addMasterlistItem (Admin: Add/Update Masterlist) ----------
  // No unique constraint on plu_code in the masterlist table, so this does
  // a manual check-then-update-or-insert (rather than a Postgres upsert,
  // which needs a unique/conflict target to work correctly) — matches the
  // {updated: true/false} shape submitMasterlistItem()'s status message
  // already expects.
  function addMasterlistItemToSupabase(plu, description, material, uom, category){
    return sb.from('masterlist').select('id').eq('plu_code', plu)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);

        if(res.data && res.data.length){
          return sb.from('masterlist')
            .update({ description: description, material: material, uom: uom, category: category })
            .eq('plu_code', plu)
            .then(function(updRes){
              if(updRes.error) throw new Error(updRes.error.message);
              return { updated: true };
            });
        }

        return sb.from('masterlist')
          .insert([{ plu_code: plu, description: description, material: material, uom: uom, category: category, added_plant: currentOutletPlant }])
          .then(function(insRes){
            if(insRes.error) throw new Error(insRes.error.message);
            return { updated: false };
          });
      });
  }

  // ---------- Supabase: submitBadStock ----------
  // Cart items no longer share one category (category now comes from each
  // item's own masterlist lookup), so this splits the cart into one group
  // per category — plus a separate "unresolved" group (category = null)
  // for unmatched "Proceed Anyway" items — and for each group either
  // stacks into today's existing pending batch for that same
  // staff+supervisor+category, or starts a new one:
  //   - Same PLU already in that batch → quantity sums into the existing
  //     row (matches the merge behavior already used within one
  //     submission, just extended across separate same-day submissions).
  //   - New PLU for that batch → inserted as a new row.
  // Plant/SLoc/Reason stay fixed values for every Fresh Market entry.
  function dayBoundsISO(dateLike){
    var d = new Date(dateLike);
    var start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    var end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }

  // Reference number: plant + MMYY + disposal id (01 Fresh Market, 02 Goods) + 3-digit
  // sequence, handed out by the database so two devices can never get the same one.
  function genRefNo(plant, disposalId){
    return sb.rpc('drs_next_ref', { p_plant: plant, p_disposal: disposalId }).then(function(res){
      if(res.error || !res.data) throw new Error('Could not generate a Reference Number' + (res.error ? ': ' + res.error.message : '.'));
      return String(res.data);
    });
  }

  // Finds a pending (or other status) batch for a given category/staff/
  // supervisor within one calendar day. referenceDate defaults to now
  // (used at submit time); Admin's Problem PLU resolution passes each
  // unresolved row's own entry_date instead, since a PLU might get fixed
  // days after it was originally scanned — the same-day rule always
  // applies to the ROW's day, not "today".
  function findBatchForDay(plant, category, staff, supervisor, checkedBy, status, referenceDate){
    var bounds = dayBoundsISO(referenceDate || new Date());
    var query = sb.from('bad_stock_fresh_market')
      .select('batch_id, plu_code, quantity, id, ref_no')
      .eq('status', status)
      .eq('plant', plant)
      .eq('staff', staff)
      .eq('supervisor', supervisor)
      .gte('entry_date', bounds.startISO)
      .lt('entry_date', bounds.endISO);
    query = category ? query.eq('category', category) : query.is('category', null);
    // New-format entries (with a Checked By name) only stack with the same Checked By;
    // older rows (no Checked By) only stack with other older rows.
    query = checkedBy ? query.eq('checked_by', checkedBy) : query.is('checked_by', null);

    return query.then(function(res){
      if(res.error) throw new Error(res.error.message);
      if(!res.data.length) return null;
      return { batchId: res.data[0].batch_id, existingRows: res.data };
    });
  }

  function submitGroupToSupabase(plant, category, staff, supervisor, checkedBy, status, groupItems, submissionId, entryDate){
    var when = entryDate ? new Date(entryDate) : new Date();
    return findBatchForDay(plant, category, staff, supervisor, checkedBy, status, when)
      .then(function(existing){
        // A brand-new pending batch gets a Reference Number; stacking onto an existing
        // batch keeps whatever that batch already has (older batches have none).
        var refP = existing ? Promise.resolve(existing.existingRows[0].ref_no || null)
                            : (status === 'pending' ? genRefNo(plant, '01') : Promise.resolve(null));
        return refP.then(function(refNo){
        var batchId = existing ? existing.batchId : ('B' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase());
        var existingByPlu = {};
        if(existing){
          existing.existingRows.forEach(function(r){ existingByPlu[String(r.plu_code).trim()] = r; });
        }

        var now = when.toISOString();
        var ops = [];
        var newRows = [];

        groupItems.forEach(function(item){
          var existingRow = existingByPlu[String(item.plu).trim()];
          if(existingRow){
            var newQty = Math.round((existingRow.quantity + item.qty) * 100) / 100;
            // submission_id updates to this newest contributing submission
            // — used later to trace "does this row's most recent
            // submission still have an unresolved sibling item elsewhere".
            ops.push(sb.from('bad_stock_fresh_market').update({ quantity: newQty, submission_id: submissionId }).eq('id', existingRow.id));
          } else {
            newRows.push({
              batch_id: batchId,
              entry_date: now,
              category: category,
              staff: staff,
              supervisor: supervisor,
              checked_by: checkedBy || null,
              plu_code: item.plu,
              description: item.description,
              material: item.material,
              quantity: item.qty,
              uom: item.uom,
              plant: plant,
              sloc: '1000',
              reason: '2',
              status: status,
              ref_no: refNo,
              submission_id: submissionId
            });
          }
        });

        if(newRows.length) ops.push(sb.from('bad_stock_fresh_market').insert(newRows));

        return Promise.all(ops).then(function(results){
          results.forEach(function(r){ if(r.error) throw new Error(r.error.message); });
          return true;
        });
        });
      });
  }

  function submitBadStockToSupabase(outlet, staff, supervisor, checkedBy, items, resumeSubmissionId, entryDate){
    // One submissionId per New Entry submit click, shared across every
    // category batch (and the unresolved batch) that this cart's items
    // split into — this is what lets printBatch() later trace "is this
    // batch's originating submission still incomplete elsewhere" and
    // block printing until every sibling item is resolved.
    var submissionId = resumeSubmissionId || ('S' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase());

    var groups = {};
    items.forEach(function(item){
      var key = item.category || '__UNRESOLVED__';
      if(!groups[key]) groups[key] = [];
      groups[key].push(item);
    });

    var groupKeys = Object.keys(groups);
    var doneKeys = {};

    return groupKeys.reduce(function(chain, key){
      return chain.then(function(){
        var isUnresolved = key === '__UNRESOLVED__';
        var category = isUnresolved ? null : key;
        var status = isUnresolved ? 'unresolved' : 'pending';
        return submitGroupToSupabase(outlet, category, staff, supervisor, checkedBy, status, groups[key], submissionId, entryDate)
          .then(function(){ doneKeys[key] = true; });
      });
    }, Promise.resolve()).then(function(){
      return { count: items.length };
    }).catch(function(err){
      // Tell the caller which items were NOT saved, so an offline retry
      // only re-sends those (re-sending saved ones would double their qty).
      err.remainingItems = items.filter(function(it){ return !doneKeys[it.category || '__UNRESOLVED__']; });
      err.submissionId = submissionId;
      throw err;
    });
  }

  // ---------- Supabase: resolveProblemPlu (IT Entry: Problem PLUs) ----------
  // Fixing an unresolved PLU means every bad_stock_fresh_market row that
  // used it needs to move OUT of its category-less "unresolved" bucket
  // and INTO the correct real-category pending batch — following the same
  // same-day/staff/supervisor stacking rule used at submission time, but
  // anchored to each row's own entry_date rather than "today", since a
  // PLU might get fixed days after it was originally scanned.
  function resolveUnresolvedRowsForPlu(plu, description, material, uom, category){
    return sb.from('bad_stock_fresh_market')
      .select('*')
      .eq('plu_code', plu)
      .eq('status', 'unresolved')
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        var rows = res.data;
        if(!rows.length) return true;

        // Group by plant + staff + supervisor + calendar day — each group
        // needs its own find-or-create pending batch, since different
        // outlets, different days, or different staff/supervisor pairs
        // must never share a batch.
        var groups = {};
        rows.forEach(function(row){
          var day = new Date(row.entry_date);
          day.setHours(0, 0, 0, 0);
          var groupKey = row.plant + '||' + row.staff + '||' + row.supervisor + '||' + (row.checked_by || '') + '||' + day.toISOString();
          if(!groups[groupKey]) groups[groupKey] = [];
          groups[groupKey].push(row);
        });

        var groupKeys = Object.keys(groups);
        return groupKeys.reduce(function(chain, gKey){
          return chain.then(function(){
            var groupRows = groups[gKey];
            var first = groupRows[0];

            return findBatchForDay(first.plant, category, first.staff, first.supervisor, first.checked_by, 'pending', first.entry_date)
              .then(function(existing){
               var refP = existing ? Promise.resolve(existing.existingRows[0].ref_no || null) : genRefNo(first.plant, '01');
               return refP.then(function(refNo){
                var ops = [];
                var totalQty = Math.round(groupRows.reduce(function(sum, r){ return sum + r.quantity; }, 0) * 100) / 100;

                if(existing){
                  var existingByPlu = {};
                  existing.existingRows.forEach(function(r){ existingByPlu[String(r.plu_code).trim()] = r; });
                  var targetRow = existingByPlu[String(plu).trim()];

                  if(targetRow){
                    // The target batch already has a row for this PLU
                    // (e.g. someone submitted it correctly matched later
                    // that same day) — merge this quantity into it and
                    // drop the now-redundant unresolved row(s).
                    var mergedQty = Math.round((targetRow.quantity + totalQty) * 100) / 100;
                    ops.push(sb.from('bad_stock_fresh_market').update({ quantity: mergedQty }).eq('id', targetRow.id));
                    ops.push(sb.from('bad_stock_fresh_market').delete().in('id', groupRows.map(function(r){ return r.id; })));
                  } else {
                    // Repoint the first row into the existing batch with
                    // the resolved details; fold any extra same-plu rows'
                    // quantity into it and delete those extras.
                    ops.push(sb.from('bad_stock_fresh_market').update({
                      batch_id: existing.batchId, category: category, status: 'pending', ref_no: refNo,
                      description: description, material: material, uom: uom, quantity: totalQty
                    }).eq('id', first.id));
                    if(groupRows.length > 1){
                      ops.push(sb.from('bad_stock_fresh_market').delete().in('id', groupRows.slice(1).map(function(r){ return r.id; })));
                    }
                  }
                } else {
                  // No pending batch exists yet for that day — this row
                  // becomes the seed of a brand new one.
                  var newBatchId = 'B' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
                  ops.push(sb.from('bad_stock_fresh_market').update({
                    batch_id: newBatchId, category: category, status: 'pending', ref_no: refNo,
                    description: description, material: material, uom: uom, quantity: totalQty
                  }).eq('id', first.id));
                  if(groupRows.length > 1){
                    ops.push(sb.from('bad_stock_fresh_market').delete().in('id', groupRows.slice(1).map(function(r){ return r.id; })));
                  }
                }

                return Promise.all(ops);
               });
              });
          });
        }, Promise.resolve());
      });
  }

  function resolveProblemPlu(plu, description, material, uom, category){
    return addMasterlistItemToSupabase(plu, description, material, uom, category)
      .then(function(){
        return resolveUnresolvedRowsForPlu(plu, description, material, uom, category);
      });
  }

  // ---------- Supabase: getPendingEntries ----------
  // Reads all rows with status='pending' and groups the flat rows back
  // into the {txnId, category, staff, supervisor, dateDisplay, items:[...]}
  // batch shape the rest of the app (renderPendingList etc.) already
  // expects — mirrors what the old Apps Script backend used to hand back.
  // Items always show in the order they were first entered (row id), so the
  // card, the printout and a later reload all agree.
  function sortItemsById(batch){
    batch.items.sort(function(x, y){ return Number(x.id) - Number(y.id); });
    return batch;
  }

  function getPendingEntriesFromSupabase(status){
    return sb.from('bad_stock_fresh_market')
      .select('*')
      .eq('status', status || 'pending')
      .eq('plant', currentOutletPlant)
      .order('entry_date', { ascending: true })
      .order('id', { ascending: true })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);

        var batches = {};
        var order = [];

        res.data.forEach(function(row){
          if(!batches[row.batch_id]){
            batches[row.batch_id] = {
              txnId: row.batch_id,
              category: row.category,
              staff: row.staff,
              supervisor: row.supervisor,
              checkedBy: row.checked_by || '',
              refNo: row.ref_no || '',
              deletedAt: row.deleted_at || null,
              dateDisplay: formatDateDisplay(row.entry_date),
              entryDate: row.entry_date,
              keyInBy: row.key_in_by || '',
              revertedAt: row.reverted_at || null,
              revertedDoc: row.reverted_doc || '',
              items: []
            };
            order.push(row.batch_id);
          }
          var masterMatch = masterlistByPlu[String(row.plu_code).trim()];
          batches[row.batch_id].items.push({
            id: row.id,             // needed later to update/delete this exact row
            plu: row.plu_code,
            // Falls back to the masterlist cache when the stored value is
            // blank — this is how a previously-unmatched item (added
            // before its PLU existed in Masterlist) self-heals once an
            // admin adds it, without silently overwriting items that were
            // already matched correctly at submission time.
            description: row.description || (masterMatch ? masterMatch.description : ''),
            material: row.material || (masterMatch ? masterMatch.material : ''),
            uom: row.uom || (masterMatch ? masterMatch.uom : ''),
            qty: row.quantity,
            submissionId: row.submission_id
          });
        });

        return order.map(function(key){ return sortItemsById(batches[key]); });
      });
  }

  // ---------- Supabase: getCompletedEntries ----------
  // Reads status='keyed_in' rows between an explicit Date From / Date To
  // range (inclusive of both days) and groups them the same way as
  // getPendingEntriesFromSupabase, plus materialDocument/keyInBy at the
  // batch level. Nothing is ever deleted from Supabase — this only
  // controls what gets fetched into the app; everything outside the
  // chosen range stays fully intact and visible in Supabase itself.
  function getCompletedEntriesFromSupabase(fromDateStr, toDateStr){
    // fromDateStr/toDateStr are 'YYYY-MM-DD' values straight from the
    // date inputs. Bounds are computed as local-day boundaries so "To"
    // includes the entire selected day, not just its first instant.
    var fromBound = new Date(fromDateStr + 'T00:00:00');
    var toBound = new Date(toDateStr + 'T23:59:59.999');

    return sb.from('bad_stock_fresh_market')
      .select('*')
      .eq('status', 'keyed_in')
      .eq('plant', currentOutletPlant)
      .gte('entry_date', fromBound.toISOString())
      .lte('entry_date', toBound.toISOString())
      .order('entry_date', { ascending: false })
      .order('id', { ascending: true })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);

        var batches = {};
        var order = [];

        res.data.forEach(function(row){
          if(!batches[row.batch_id]){
            batches[row.batch_id] = {
              txnId: row.batch_id,
              category: row.category,
              staff: row.staff,
              supervisor: row.supervisor,
              checkedBy: row.checked_by || '',
              refNo: row.ref_no || '',
              dateDisplay: formatDateDisplay(row.entry_date),
              materialDocument: row.material_document || '',
              keyInBy: row.key_in_by || '',
              items: []
            };
            order.push(row.batch_id);
          }
          batches[row.batch_id].items.push({
            id: row.id,
            plu: row.plu_code,
            description: row.description,
            material: row.material,
            uom: row.uom,
            qty: row.quantity,
            submissionId: row.submission_id
          });
        });

        return order.map(function(key){ return sortItemsById(batches[key]); });
      });
  }

  // Matches your original sheet's "d.M.yyyy h.mm AM/PM" display format
  function formatDateDisplay(isoString){
    var d = new Date(isoString);
    var day = d.getDate();
    var month = d.getMonth() + 1;
    var year = d.getFullYear();
    var hours = d.getHours();
    var minutes = d.getMinutes();
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12; if(hours === 0) hours = 12;
    var minStr = minutes < 10 ? '0' + minutes : String(minutes);
    return day + '.' + month + '.' + year + ' ' + hours + '.' + minStr + ' ' + ampm;
  }

  // ---------- Supabase: saveITEntryDraft ----------
  // Reconciles a batch's current item list against Supabase: updates rows
  // that already have an id, inserts newly-added items (isNew, carrying
  // batchInfo's category/staff/supervisor + fixed plant/sloc/reason so
  // they match the rest of the batch), and deletes rows that were removed
  // from the draft (present in Supabase but no longer in items).
  function saveITEntryDraftToSupabase(txnId, items, batchInfo){
    var existingIds = items.filter(function(it){ return it.id; }).map(function(it){ return it.id; });

    var updates = items.filter(function(it){ return it.id; }).map(function(it){
      return sb.from('bad_stock_fresh_market')
        .update({ description: it.description, material: it.material, uom: it.uom, quantity: it.qty })
        .eq('id', it.id);
    });

    // New items added via IT Entry's "Add PLU" split the same way New
    // Entry's submit does: matched items belong in THIS batch; unmatched
    // ones must never land here with a borrowed category/status — they
    // get routed to the outlet's unresolved bucket via the same
    // find-or-create-by-day logic New Entry uses, then removed from this
    // batch's local item list entirely once that succeeds.
    var newMatchedItems = items.filter(function(it){ return it.isNew && !it.unmatched; });
    var newUnmatchedItems = items.filter(function(it){ return it.isNew && it.unmatched; });

    // Keep a reference to the actual new item objects (not just plain
    // insert payloads) so that once Supabase assigns them real row ids,
    // we can write those ids back onto the same objects living in
    // pendingDraft[key].items. Without this, a newly-added item would
    // stay "idless" forever after its first save — on the next save/
    // submit it would look like neither an existing row (no id) nor a
    // new one (isNew already cleared), and its real Supabase row would
    // get swept into the delete step below since nothing on the client
    // still pointed at it.
    var newRows = newMatchedItems.map(function(it){
      return {
        batch_id: txnId,
        entry_date: batchInfo.entryDate || new Date().toISOString(),
        category: batchInfo.category,
        staff: batchInfo.staff,
        supervisor: batchInfo.supervisor,
        checked_by: batchInfo.checkedBy || null,
        plu_code: it.plu,
        description: it.description,
        material: it.material,
        quantity: it.qty,
        uom: it.uom,
        plant: currentOutletPlant,
        sloc: '1000',
        reason: '2',
        status: batchInfo.status || 'pending',
        reverted_at: batchInfo.revertedAt || null,
        reverted_doc: batchInfo.revertedDoc || null,
        ref_no: batchInfo.refNo || null
      };
    });

    return sb.from('bad_stock_fresh_market').select('id').eq('batch_id', txnId)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        var toDelete = res.data.map(function(r){ return r.id; }).filter(function(id){ return existingIds.indexOf(id) === -1; });

        var ops = updates.slice();
        if(newRows.length){
          ops.push(
            sb.from('bad_stock_fresh_market').insert(newRows).select('id')
              .then(function(insertRes){
                if(insertRes.error) throw new Error(insertRes.error.message);
                insertRes.data.forEach(function(row, idx){
                  newMatchedItems[idx].id = row.id;
                  newMatchedItems[idx].isNew = false;
                });
                return insertRes;
              })
          );
        }
        if(toDelete.length) ops.push(sb.from('bad_stock_fresh_market').delete().in('id', toDelete));

        return Promise.all(ops);
      })
      .then(function(results){
        results.forEach(function(r){ if(r.error) throw new Error(r.error.message); });

        if(!newUnmatchedItems.length) return true;

        // Reuse this batch's own submission_id (from an existing row)
        // rather than generating an unrelated new one — this is what lets
        // the print gate later recognize "this batch still has a sibling
        // item stuck unresolved" for an item added mid-way via IT Entry's
        // Add PLU, not just ones split apart at the original New Entry
        // submission. Falls back to a fresh id only for legacy batches
        // that predate submission_id existing at all (nothing to link to
        // in that case anyway).
        var existingSubmissionId = null;
        items.some(function(it){
          if(it.id && it.submissionId){ existingSubmissionId = it.submissionId; return true; }
          return false;
        });
        var submissionId = existingSubmissionId || ('S' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase());
        return submitGroupToSupabase(currentOutletPlant, null, batchInfo.staff, batchInfo.supervisor, batchInfo.checkedBy, 'unresolved', newUnmatchedItems, submissionId)
          .then(function(){
            // Routed away successfully — these no longer belong in this
            // batch's local item list at all.
            for(var i = items.length - 1; i >= 0; i--){
              if(items[i].isNew && items[i].unmatched) items.splice(i, 1);
            }
            return true;
          });
      });
  }

  // ---------- Supabase: submitITEntry ----------
  // Saves any pending item edits first (same reconciliation as Save
  // Changes), then marks every row in the batch as keyed_in with the
  // Material Document / Key In By / Key In Date, and returns the data
  // needed to render the print slip.
  function submitITEntryToSupabase(txnId, items, batchInfo, materialDocument, keyInBy){
    return saveITEntryDraftToSupabase(txnId, items, batchInfo)
      .then(function(){
        return sb.from('bad_stock_fresh_market')
          .update({
            material_document: materialDocument,
            key_in_by: keyInBy,
            key_in_date: new Date().toISOString(),
            status: 'keyed_in'
          })
          .eq('batch_id', txnId);
      })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return sb.from('bad_stock_fresh_market').select('*').eq('batch_id', txnId).order('id', { ascending: true });
      })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        var rows = res.data;
        var first = rows[0] || {};
        return {
          printData: {
            date: formatDateDisplay(first.entry_date),
            time: '',
            category: first.category,
            staff: first.staff,
            supervisor: first.supervisor,
            checkedBy: first.checked_by || '',
            refNo: first.ref_no || '',
            materialDocument: materialDocument,
            keyInBy: keyInBy,
            items: rows.map(function(r){
              return { plu: r.plu_code, description: r.description, material: r.material, uom: r.uom, qty: r.quantity, submissionId: r.submission_id };
            })
          }
        };
      });
  }

  // ---------- Supabase: deletePendingBatch ----------
  // A batch with a Reference Number is never erased: it is marked 'deleted' and stays
  // visible in Admin > Deleted Disposal Record. Older batches without one are removed as before.
  function deletePendingBatchFromSupabase(txnId, keepRecord){
    var q = keepRecord
      ? sb.from('bad_stock_fresh_market').update({ status: 'deleted', deleted_at: new Date().toISOString() }).eq('batch_id', txnId).eq('status', 'pending')
      : sb.from('bad_stock_fresh_market').delete().eq('batch_id', txnId);
    return q.then(function(res){
        if(res.error) throw new Error(res.error.message);
        return true;
      });
  }

  var masterlist = [];         // full masterlist loaded once at startup
  var masterlistByPlu = {};    // fast lookup map: plu -> {description, material, uom}
  var currentLookup = null;    // currently matched PLU item awaiting quantity (New Entry)
  var cart = [];               // { plu, description, material, uom, qty }
  var revFm = [];              // reverted Fresh Market batches (Reverted Disposal tab)
  var revGd = [];              // reverted Goods batches
  var revLoaded = false;
  var pendingEntries = [];     // raw data from getPendingEntries()
  var pendingDraft = {};       // keyed by txnId -> { items, materialDocument, keyInBy }
  var adminUnlocked = false;
  var appCategories = [];      // set once from getCategoriesFromSupabase()
  var selectedPendingCategory = null; // which category is currently shown in IT Entry
  var itEntrySubView = 'pending';     // 'pending' or 'completed', within IT Entry
  var completedEntries = [];          // raw data from getCompletedEntriesFromSupabase()
  var selectedCompletedCategory = null;

  // ---------- Startup: load masterlist once, cache client-side ----------
  var outletPending = false;
  function hasStoredOutlet(){
    try { return !!localStorage.getItem(OUTLET_STORAGE_KEY); } catch(e){ return false; }
  }
  function confirmFirstOutlet(){
    var plant = document.getElementById('firstOutletSelect').value;
    var pw = document.getElementById('firstOutletPassword');
    var st = document.getElementById('firstOutletStatus');
    if(!pw.value || pw.value.trim() !== OUTLET_PASSWORDS[plant]){
      st.innerHTML = '<div class="status err">' + (pw.value ? 'Wrong password for ' : 'Enter the password for ') + escapeHtml(outletLabel(plant)) + '.</div>';
      pw.value = ''; pw.focus();
      return;
    }
    try { localStorage.setItem(OUTLET_STORAGE_KEY, plant); } catch(e){ /* still applies for this page load */ }
    currentOutletPlant = plant;
    outletPending = false;
    pw.value = '';
    document.getElementById('firstOutletOverlay').style.display = 'none';
    applyOutletBranding();
    startApp();
  }
  window.addEventListener('DOMContentLoaded', function(){
    applySidebarPreference();
    if(!hasStoredOutlet()){
      outletPending = true;
      var sel = document.getElementById('firstOutletSelect');
      sel.innerHTML = '<option value="">- Select outlet -</option>' + OUTLET_OPTIONS.map(function(o){
        return '<option value="' + o.plant + '">' + escapeHtml(o.label) + '</option>';
      }).join('');
      document.getElementById('firstOutletOverlay').style.display = 'flex';
      return;
    }
    startApp();
  });
  var splashStart = 0;
  function showSplash(){
    var el = document.getElementById('loadingView');
    var o = document.getElementById('welcomeOutlet');
    if(o) o.textContent = outletLabel(currentOutletPlant);
    if(el){ el.classList.remove('fade-out'); el.style.display = 'flex'; }
    splashStart = Date.now();
  }
  // Keeps the welcome screen up long enough to be read, then fades it out.
  function hideSplash(){
    var el = document.getElementById('loadingView');
    if(!el) return;
    var wait = Math.max(0, 1500 - (Date.now() - splashStart));
    setTimeout(function(){
      el.classList.add('fade-out');
      setTimeout(function(){ el.style.display = 'none'; }, 380);
    }, wait);
  }

  function startApp(){
    showSplash();
    refreshHomeDashboard();
    revUpdateCount();
    getMasterlistFromSupabase()
      .then(function(list){
        masterlist = list;
        masterlistByPlu = {};
        list.forEach(function(item){ masterlistByPlu[String(item.plu).trim()] = item; });
        loadCategories();
      })
      .catch(function(err){
        document.getElementById('loadingView').innerHTML =
          '<div class="status err" style="max-width:420px;">Failed to load product list: ' + err.message + '</div>';
      });
  }

  // Categories live in Supabase (a `categories` table) rather than being
  // hardcoded per-repo — this is what lets Admin add a new one from
  // either outlet's device and have it appear on the OTHER outlet's
  // deployment too, the same way the Masterlist is already shared.
  function getCategoriesFromSupabase(){
    return sb.from('categories').select('name').order('id', { ascending: true })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return res.data.map(function(row){ return row.name; });
      });
  }

  // Multi-outlet support: each outlet gets its own deployment/repo of this
  // same codebase, sharing one Supabase project and masterlist but keeping
  // transaction data separated by plant code. DEFAULT_OUTLET_PLANT is the
  // ONE line that needs changing when cloning this repo for another
  // outlet (e.g. '1015' for the future 1015-SHPL repo) — everything else
  // (defaults, batching, filtering) follows from it automatically.
  //
  // The outlet itself is a fixed, device-level setting (not something
  // staff pick per transaction) — set once by Admin, persisted in
  // localStorage, and applied to every read/write in the app: New Entry
  // submissions, IT Entry, Completed, and Problem PLUs all scope to
  // whichever outlet is currently set on this device. The Masterlist has
  // no outlet field at all and always stays shared between outlets.
  var OUTLET_OPTIONS = [
    { plant: '1008', label: '1008-SHBN', shortName: 'SHBN' },
    { plant: '1015', label: '1015-SHPL', shortName: 'SHPL' },
    { plant: '1007', label: '1007-SHPP', shortName: 'SHPP' }
  ];
  var DEFAULT_OUTLET_PLANT = '1008';
  var OUTLET_STORAGE_KEY = 'shbn_bad_stock_outlet_v1';

  function getCurrentOutlet(){
    try {
      return localStorage.getItem(OUTLET_STORAGE_KEY) || DEFAULT_OUTLET_PLANT;
    } catch (e) {
      return DEFAULT_OUTLET_PLANT;
    }
  }

  var currentOutletPlant = getCurrentOutlet();

  function outletLabel(plant){
    var match = OUTLET_OPTIONS.find(function(o){ return o.plant === plant; });
    return match ? match.label : plant;
  }

  // Falls back to 'SHBN' (this app's original outlet) for a plant with no
  // configured OUTLET_OPTIONS entry, rather than showing a raw plant code
  // in the header/report title.
  function outletShortName(plant){
    var match = OUTLET_OPTIONS.find(function(o){ return o.plant === plant; });
    return match ? match.shortName : 'SHBN';
  }

  // Keeps the header title and the outlet notice banner in sync with
  // whichever outlet is currently active on this device — called on
  // startup and again whenever Admin switches outlets, so the app (and
  // anything printed from it) always identifies the right store.
  function applyOutletBranding(){
    var label = outletLabel(currentOutletPlant);
    var pill = document.getElementById('outletPillText');
    if(pill) pill.textContent = label;
    var um = document.getElementById('userMenuOutlet');
    if(um) um.textContent = 'Outlet: ' + label;
  }

  // Reflects the current category list in the header subtitle, so it
  // never goes stale after Admin adds a new one.
  function updateCategorySubtitle(){ /* header subtitle is fixed in DRS */ }

  function loadCategories(){
    getCategoriesFromSupabase()
      .then(function(categories){
        appCategories = categories;
        updateCategorySubtitle();
        applyOutletBranding();
        hideSplash();
        lastSyncAt = Date.now();
        nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
        showTab('home');
        refreshHomeDashboard();
        loadPendingEntries({silent:true, force:true}).then(refreshHomeDashboard).catch(function(){});
        loadProblemPlus({silent:true, force:true}).then(refreshHomeDashboard).catch(function(){});
        flushOutbox();
        gdInit();

        var draft = loadDraft();
        if(draft && draft.staff && draft.supervisor && !draft.checkedBy){
          // Draft saved before "Checked By" existed: keep the items, ask for the new name first.
          cart = draft.cart || [];
          document.getElementById('staffInput').value = draft.staff;
          document.getElementById('supervisorInput').value = draft.supervisor;
          // FIX: show Step 1 here. Previously nothing made step1View visible in
          // this branch, so the page was blank on devices holding an old draft.
          document.getElementById('step1View').style.display = 'block';
          document.getElementById('step1Status').innerHTML = '<div class="status err">You have an unsent list. Enter Checked By, then Continue to keep going.</div>';
          renderCart();
        } else if(draft && draft.staff && draft.supervisor){
          sessionStaff = draft.staff;
          sessionSupervisor = draft.supervisor;
          sessionChecked = draft.checkedBy;
          cart = draft.cart || [];

          document.getElementById('staffInput').value = sessionStaff;
          document.getElementById('supervisorInput').value = sessionSupervisor;
          document.getElementById('checkedByInput').value = sessionChecked;

          enterStep2();
          renderCart();

          // Restore an in-progress PLU/qty lookup that hadn't been added
          // to the cart yet when the connection dropped or the page was
          // refreshed, so nothing the person typed gets lost.
          if(draft.pluInput){
            document.getElementById('pluInput').value = draft.pluInput;
            lookupPlu();
            if(draft.qtyInput) document.getElementById('qtyInput').value = draft.qtyInput;
          }
        } else {
          document.getElementById('step1View').style.display = 'block';
        }
      })
      .catch(function(err){
        document.getElementById('loadingView').innerHTML =
          '<div class="status err">Failed to load categories: ' + err.message + '</div>';
      });
  }

  // ---------- Tab switching ----------
  var TAB_VIEWS = { home:'homeTabView', 'new':'newTabView', gnew:'gnewTabView', it:'itTabView', git:'gitTabView', docs:'docsTabView', rv:'rvTabView', sum:'sumTabView', store:'adminTabView', master:'adminTabView', admin:'adminTabView' };
  var TAB_SIDE = { home:'sideBtnHome', 'new':'sideBtnNew', gnew:'sideBtnGnew', it:'sideBtnIt', git:'sideBtnIt', docs:'sideBtnDocs', rv:'sideBtnIt', sum:'sideBtnSum', store:'sideBtnStore', master:'sideBtnMaster', admin:'sideBtnAdmin' };
  var lastRecordsType = 'it';

  function showTab(tab){
    if(tab !== currentTab && editingBlocked()) return;
    closeMobileNav();
    currentTab = tab;
    Object.keys(TAB_VIEWS).forEach(function(k){
      var el = document.getElementById(TAB_VIEWS[k]);
      if(el) el.style.display = TAB_VIEWS[k] === TAB_VIEWS[tab] ? 'block' : 'none';
    });
    var bar = document.getElementById('recordsBar');
    if(bar) bar.style.display = (tab === 'it' || tab === 'git' || tab === 'rv') ? 'flex' : 'none';
    var recFm = document.getElementById('recBtnFm'), recGd = document.getElementById('recBtnGd');
    if(recFm) recFm.classList.toggle('active', tab === 'it');
    if(recGd) recGd.classList.toggle('active', tab === 'git');
    var recRv = document.getElementById('recBtnRv');
    if(recRv) recRv.classList.toggle('active', tab === 'rv');

    ['sideBtnHome','sideBtnNew','sideBtnGnew','sideBtnIt','sideBtnDocs','sideBtnMaster','sideBtnStore','sideBtnSum','sideBtnAdmin'].forEach(function(id){
      var el = document.getElementById(id);
      if(el) el.classList.toggle('active', TAB_SIDE[tab] === id);
    });
    var grp = document.getElementById('sideBtnNewGroup');
    if(grp) grp.classList.toggle('group-active', tab === 'new' || tab === 'gnew');
    closeUserMenu();

    if(tab === 'it'){
      lastRecordsType = 'it';
      loadPendingEntries().then(function(){ lastSyncAt = Date.now(); nextRefreshAt = Date.now() + AUTO_REFRESH_MS; updateSyncUi(); refreshHomeDashboard(); });
      if(itEntrySubView === 'problem') loadProblemPlus({silent:true, force:true}).then(refreshHomeDashboard).catch(function(){});
      gdLoadPending({silent:true, force:true}).then(gdUpdateRecordCounts).catch(function(){});
    }
    if(tab === 'git'){
      lastRecordsType = 'git';
      gdLoadPending().then(function(){ lastSyncAt = Date.now(); nextRefreshAt = Date.now() + AUTO_REFRESH_MS; updateSyncUi(); refreshHomeDashboard(); });
      loadPendingEntries({silent:true, force:true}).then(gdUpdateRecordCounts).catch(function(){});
    }
    if(tab === 'rv') revLoad();
    if(tab === 'sum') sumInit();
    if(tab === 'admin' || tab === 'master' || tab === 'store'){ adminSwitchPane(tab); populateAdminOutletDropdown(); populateAdminCategoryDropdown(); }
    if(tab === 'master') loadRecentMasterActivity();
    if(tab === 'docs') docsLoadRecent();
    if(tab === 'home'){
      refreshHomeDashboard();
      loadPendingEntries({silent:true, force:true}).then(refreshHomeDashboard).catch(function(){});
      gdLoadPending({silent:true, force:true}).then(refreshHomeDashboard).catch(function(){});
    }
    window.scrollTo(0, 0);
    updateSyncUi();
  }
  function openRecords(){ showTab(lastRecordsType === 'git' ? 'git' : 'it'); }
  function toggleMobileNav(){
    var sb2 = document.getElementById('appSidebar');
    if(sb2.classList.contains('mobile-open')) closeMobileNav(); else openMobileNav();
  }
  function openMobileNav(){
    document.getElementById('appSidebar').classList.add('mobile-open');
    document.getElementById('sidebarBackdrop').classList.add('show');
    var t = document.getElementById('navToggle'); if(t) t.setAttribute('aria-expanded', 'true');
  }
  function closeMobileNav(){
    var a = document.getElementById('appSidebar'); if(a) a.classList.remove('mobile-open');
    var b = document.getElementById('sidebarBackdrop'); if(b) b.classList.remove('show');
    var t = document.getElementById('navToggle'); if(t) t.setAttribute('aria-expanded', 'false');
  }
  window.addEventListener('resize', function(){ if(!window.matchMedia('(max-width:700px),(hover:none) and (pointer:coarse)').matches) closeMobileNav(); });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeMobileNav(); });
  function toggleNewMenu(){
    var sub = document.getElementById('newSubMenu');
    var grp = document.getElementById('sideBtnNewGroup');
    var open = sub.style.display === 'none';
    sub.style.display = open ? '' : 'none';
    grp.classList.toggle('sidebar-group-open', open);
  }
  function toggleUserMenu(ev){
    if(ev) ev.stopPropagation();
    document.getElementById('userMenu').classList.toggle('open');
  }
  function closeUserMenu(){
    var m = document.getElementById('userMenu'); if(m) m.classList.remove('open');
  }
  document.addEventListener('click', closeUserMenu);

  var SIDEBAR_PIN_KEY = 'shbn_bad_stock_sidebar_pinned_v1';
  function applySidebarPreference(){
    var sidebar = document.getElementById('appSidebar');
    var btn = document.getElementById('sidebarPinBtn');
    var label = document.getElementById('sidebarPinLabel');
    var pinned = false;
    try { pinned = localStorage.getItem(SIDEBAR_PIN_KEY) === '1'; } catch(e) {}
    sidebar.classList.toggle('pinned', pinned);
    if(btn){ btn.setAttribute('aria-pressed', pinned ? 'true' : 'false'); btn.title = pinned ? 'Unpin sidebar' : 'Pin sidebar open'; }
    if(label) label.textContent = pinned ? 'Unpin sidebar' : 'Pin sidebar open';
  }
  function toggleSidebarPin(){
    var sidebar = document.getElementById('appSidebar');
    var pinned = !sidebar.classList.contains('pinned');
    sidebar.classList.toggle('pinned', pinned);
    try { localStorage.setItem(SIDEBAR_PIN_KEY, pinned ? '1' : '0'); } catch(e) {}
    var btn = document.getElementById('sidebarPinBtn');
    var label = document.getElementById('sidebarPinLabel');
    if(btn){ btn.setAttribute('aria-pressed', pinned ? 'true' : 'false'); btn.title = pinned ? 'Unpin sidebar' : 'Pin sidebar open'; }
    if(label) label.textContent = pinned ? 'Unpin sidebar' : 'Pin sidebar open';
  }
  function openDashboardSection(tab, subview){
    showTab(tab);
    if(tab === 'it' && subview){ switchItSubView(subview); }
    if(tab === 'git' && subview){ gdSwitchSubView(subview); }
  }
  function homeFmPendingCount(){
    return (pendingEntries || []).filter(function(b){
      var d = pendingDraft[pendingKey(b)];
      return !(d && d.submitted);
    }).length;
  }
  function homeGdPendingCount(){
    return (gdPending || []).filter(function(b){
      var d = gdDraft[b.txnId];
      return !(d && d.submitted);
    }).length;
  }
  function updateHomeCounts(){
    var fm = document.getElementById('homeFmCount');
    var gd = document.getElementById('homeGdCount');
    var problem = document.getElementById('homeProblemCount');
    if(fm) fm.textContent = String(homeFmPendingCount());
    if(gd) gd.textContent = String(homeGdPendingCount());
    if(problem) problem.textContent = String((problemPlus || []).length || 0);
    gdUpdateRecordCounts();
  }
  function renderHomeRecentActivity(){
    var container = document.getElementById('homeRecentActivity');
    if(!container) return;
    var rows = [];
    (pendingEntries || []).forEach(function(b){
      var d = pendingDraft[pendingKey(b)];
      if(d && d.submitted) return;
      rows.push({ type:'fm', category:b.category, staff:b.staff, when:b.entryDate || '', display:b.dateDisplay, count:(b.items || []).length });
    });
    (gdPending || []).forEach(function(b){
      var d = gdDraft[b.txnId];
      if(d && d.submitted) return;
      rows.push({ type:'gd', category:b.category, staff:b.staff, when:b.entryDate || '', display:b.dateDisplay, count:(b.items || []).length });
    });
    rows.sort(function(a, b){ return String(b.when).localeCompare(String(a.when)); });
    rows = rows.slice(0, 5);
    if(!rows.length){
      container.innerHTML = '<div class="activity-empty"><svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>No recent disposal activity to show.</div>';
      return;
    }
    container.innerHTML = '';
    rows.forEach(function(r){
      var row = document.createElement('div'); row.className = 'activity-row';
      row.innerHTML = '<span class="activity-dot"></span><div class="activity-main"><div class="activity-title"><span class="activity-tag ' + r.type + '">' +
        (r.type === 'fm' ? 'Fresh Market' : 'Goods') + '</span>' + escapeHtml(r.category || 'Disposal') + '</div><div class="activity-meta">' +
        escapeHtml(r.display || 'Pending') + ' \u00b7 ' + escapeHtml(r.staff || 'Staff not listed') + '</div></div><span class="activity-count">' + r.count + ' item(s)</span>';
      container.appendChild(row);
    });
  }
  function refreshHomeDashboard(){
    var dateEl = document.getElementById('dashboardDate');
    if(dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'short',day:'numeric'});
    var greetEl = document.getElementById('dashboardGreeting');
    if(greetEl){
      // Uses the device's local time: morning until 11:59, afternoon until 17:59, evening after.
      var h = new Date().getHours();
      greetEl.textContent = (h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening')) + ', welcome back.';
    }
    updateHomeCounts(); renderHomeRecentActivity();
  }

  // ================= NEW ENTRY =================

  // ---------- Draft persistence (survives refresh / connection drops) ----------
  // Persists: staff/supervisor/category, the whole cart, AND whatever is
  // currently sitting in the PLU / Quantity fields — so even an item the
  // person was mid-way through entering (looked up but not yet added to
  // the list) survives a lost connection or an accidental refresh.
  var DRAFT_KEY = 'shbn_bad_stock_draft_v1';

  function saveDraft(){
    try {
      var pluEl = document.getElementById('pluInput');
      var qtyEl = document.getElementById('qtyInput');
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        staff: sessionStaff,
        supervisor: sessionSupervisor,
        checkedBy: sessionChecked,
        cart: cart,
        pluInput: pluEl ? pluEl.value : '',
        qtyInput: qtyEl ? qtyEl.value : ''
      }));
    } catch (e) { /* storage unavailable — fail silently, not critical */ }
  }

  function loadDraft(){
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearDraft(){
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  }

  var sessionStaff = '', sessionSupervisor = '', sessionChecked = '';

  function goToStep2(){
    var staff = document.getElementById('staffInput').value.trim();
    var supervisor = document.getElementById('supervisorInput').value.trim();
    var checked = document.getElementById('checkedByInput').value.trim();
    var statusEl = document.getElementById('step1Status');

    if(!staff || !supervisor || !checked){
      statusEl.innerHTML = '<div class="status err">Please fill in staff name, supervisor fresh market and checked by.</div>';
      return;
    }
    statusEl.innerHTML = '';
    sessionStaff = staff; sessionSupervisor = supervisor; sessionChecked = checked;
    enterStep2();
    saveDraft();
  }

  function enterStep2(){
    document.getElementById('summaryOutlet').textContent = outletLabel(currentOutletPlant);
    document.getElementById('summaryStaff').textContent = sessionStaff;
    document.getElementById('summarySupervisor').textContent = sessionSupervisor;
    document.getElementById('summaryChecked').textContent = sessionChecked;

    document.getElementById('step1View').style.display = 'none';
    document.getElementById('step2View').style.display = 'block';
  }

  function backToStep1(){
    document.getElementById('step2View').style.display = 'none';
    document.getElementById('step1View').style.display = 'block';
  }

  function cancelEntry(){
    if(cart.length && !confirm('Discard this entry? Any items you\'ve added but not submitted will be lost.')) {
      return;
    }
    sessionStaff = ''; sessionSupervisor = ''; sessionChecked = '';
    cart = [];
    currentLookup = null;
    unmatchedConfirmed = false;
    lastLookedUpPlu = '';
    clearDraft();

    document.getElementById('staffInput').value = '';
    document.getElementById('supervisorInput').value = '';
    document.getElementById('checkedByInput').value = '';
    document.getElementById('pluInput').value = '';
    document.getElementById('qtyInput').value = '';
    document.getElementById('lookupPreview').innerHTML = '';
    document.getElementById('qtySection').style.display = 'none';
    document.getElementById('submitStatus').innerHTML = '';
    renderCart();
    backToStep1();
  }

  var unmatchedConfirmed = false;
  var lastLookedUpPlu = '';

  // ---------- Shared quantity rules: max 99.99, 2 decimal places ----------
  // Used everywhere a quantity gets added or edited (New Entry cart, IT
  // Entry pending items). Rounds to 2dp; caller decides whether to also
  // enforce the 99.99 cap (single-entry adds are capped with an alert;
  // summed duplicate-PLU totals are only rounded, not re-capped, since a
  // legitimate running total for one PLU can exceed 99.99).
  var MAX_QTY = 99.99;
  function roundQty(val){
    return Math.round(val * 100) / 100;
  }

  // ---------- Weighing-scale barcode detection ----------
  // Weighing-scale stickers print barcodes like 2850046000000 (13 digits)
  // or 285004600072000600 (18 digits): a fixed "28" prefix, then a 5-digit
  // PLU code, then a variable number of trailing digits (weight/price/
  // checksum, which differ by scale/format and are ignored either way). If
  // what's typed or scanned into the PLU field matches that shape — starts
  // with "28" and has at least 13 digits total — silently swap it for just
  // the embedded 5-digit PLU (always the 5 digits right after "28",
  // regardless of how many digits follow) so the lookup and everything
  // downstream (cart, sheet) sees a normal PLU code instead of the full
  // barcode. The 13-digit minimum keeps this from misfiring on a plain
  // manually-typed PLU that happens to start with "28" (e.g. "28046").
  // Anything shorter, or not starting with 28, passes through unchanged.
  function extractPluFromBarcode(raw){
    var digits = (raw || '').trim();
    if(/^28\d{11,}$/.test(digits)){
      return digits.substring(2, 7);
    }
    return digits;
  }

  document.getElementById('pluInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); lookupPlu(); }
  });

  function lookupPlu(){
    var rawPlu = document.getElementById('pluInput').value.trim();
    var plu = extractPluFromBarcode(rawPlu);
    if(plu !== rawPlu){
      // Reflect the interpreted PLU back into the field so what's shown
      // (and later added to the cart) is the short code, not the barcode.
      document.getElementById('pluInput').value = plu;
    }
    var previewEl = document.getElementById('lookupPreview');
    var qtySection = document.getElementById('qtySection');

    if(plu !== lastLookedUpPlu) unmatchedConfirmed = false;
    lastLookedUpPlu = plu;

    if(!plu){
      previewEl.innerHTML = '';
      qtySection.style.display = 'none';
      currentLookup = null;
      return;
    }

    var match = masterlistByPlu[plu];

    if(match){
      currentLookup = { plu: plu, description: match.description, material: match.material, uom: match.uom, category: match.category, unmatched: false };
      previewEl.innerHTML =
        '<div class="lookup-preview">' +
        '<div class="row"><span>Description</span><b>' + escapeHtml(match.description) + '</b></div>' +
        '<div class="row"><span>Material</span><b>' + escapeHtml(match.material) + '</b></div>' +
        '<div class="row"><span>UOM</span><b>' + escapeHtml(match.uom) + '</b></div>' +
        '<div class="row"><span>Category</span><b>' + escapeHtml(match.category || '\u2014') + '</b></div>' +
        '</div>';
      qtySection.style.display = 'block';
      document.getElementById('qtyInput').focus();
      return;
    }

    currentLookup = null;
    qtySection.style.display = 'none';

    if(!unmatchedConfirmed){
      previewEl.innerHTML =
        '<div class="lookup-preview notfound">' +
        '⚠ PLU "' + escapeHtml(plu) + '" was not found in the Masterlist. Please double-check the code before proceeding.' +
        '<div class="btn-row" style="margin-top:10px;">' +
        '<button type="button" class="btn ghost" onclick="confirmUnmatchedPlu()">Proceed anyway</button>' +
        '</div></div>';
    } else {
      // No category available for an unmatched item — it goes into a
      // separate "unresolved" batch at submit time until an admin adds it
      // to the masterlist with a category via Problem PLUs. A description
      // is required up front so Problem PLUs never starts from a blank
      // field — staff describes what they scanned, admin can refine it.
      currentLookup = { plu: plu, description: '', material: '', uom: '', category: null, unmatched: true };
      previewEl.innerHTML =
        '<div class="lookup-preview notfound">' +
        'This PLU isn\'t in the Masterlist yet. Please describe the item before adding it — admin can refine the details later in Problem PLUs.' +
        '<label style="margin-top:10px;">Description <span style="color:var(--danger);">*</span></label>' +
        '<input type="text" id="unmatchedDescInput" placeholder="Describe this item">' +
        '</div>';
      qtySection.style.display = 'none';

      var descInput = document.getElementById('unmatchedDescInput');
      descInput.addEventListener('input', function(){
        var val = descInput.value.trim();
        currentLookup.description = val;
        qtySection.style.display = val ? 'block' : 'none';
        // No auto-focus here — jumping focus away from this field mid-word
        // interrupts typing. Quantity simply becomes visible/available
        // once there's a description; staff moves to it themselves.
      });
    }
  }

  function confirmUnmatchedPlu(){
    unmatchedConfirmed = true;
    lookupPlu();
  }

  // Every keystroke both re-runs the lookup AND persists the in-progress
  // PLU text to the draft, so a lost connection mid-typing doesn't wipe it.
  document.getElementById('pluInput').addEventListener('input', function(){
    lookupPlu();
    saveDraft();
  });

  // The quantity field previously had no persistence at all — add it so a
  // typed-but-not-yet-added quantity also survives a refresh.
  document.getElementById('qtyInput').addEventListener('input', function(){
    saveDraft();
  });

  function addToCart(){
    if(!currentLookup) return;
    if(currentLookup.unmatched && !currentLookup.description){
      alert('Please enter a description for this PLU before adding it.');
      return;
    }
    var qty = parseFloat(document.getElementById('qtyInput').value);
    if(!qty || qty <= 0){
      alert('Please enter a valid quantity.');
      return;
    }
    if(qty > MAX_QTY){
      alert('Maximum quantity allowed is ' + MAX_QTY + '.');
      return;
    }
    qty = roundQty(qty); // accepts up to 3 decimals typed, stores only 2

    var existing = cart.find(function(c){ return c.plu === currentLookup.plu; });
    if(existing){
      // Duplicate PLU: quantities add up, rounded back to 2 decimals — not
      // re-capped at 99.99, since a legitimate running total can exceed it.
      if(!existing.entries || !existing.entries.length) existing.entries = [existing.qty];
      existing.entries.push(qty);
      existing.qty = roundQty(existing.entries.reduce(function(sum, q){ return sum + q; }, 0));
    } else {
      cart.push({
        plu: currentLookup.plu,
        description: currentLookup.description,
        material: currentLookup.material,
        uom: currentLookup.uom,
        category: currentLookup.category || null,
        qty: qty,
        entries: [qty],
        unmatched: !!currentLookup.unmatched
      });
    }

    document.getElementById('pluInput').value = '';
    document.getElementById('qtyInput').value = '';
    document.getElementById('lookupPreview').innerHTML = '';
    document.getElementById('qtySection').style.display = 'none';
    currentLookup = null;
    unmatchedConfirmed = false;
    lastLookedUpPlu = '';
    document.getElementById('pluInput').focus();

    renderCart();
    saveDraft();
  }

  function renderCart(){
    var table = document.getElementById('cartTable');
    var emptyEl = document.getElementById('cartEmpty');
    var submitBtn = document.getElementById('submitBtn');

    // Older saved drafts have no per-scan list — treat their qty as one entry.
    cart.forEach(function(it){
      if(!it.entries || !it.entries.length) it.entries = [it.qty];
    });

    document.getElementById('cartCount').textContent = cart.length;
    document.getElementById('cartCountPlural').textContent = cart.length === 1 ? '' : 's';

    if(!cart.length){
      table.style.display = 'none';
      table.innerHTML = '';
      emptyEl.style.display = 'block';
      submitBtn.disabled = true;
      return;
    }

    emptyEl.style.display = 'none';
    table.style.display = 'block';
    submitBtn.disabled = false;

    // One block per PLU: description, PLU/category/UOM, the TOTAL qty, and
    // every individual quantity that was entered for it (each editable /
    // removable). Only the total is what gets submitted and later shown
    // to IT in the pending list.
    table.innerHTML = cart.map(function(item, idx){
      var descDisplay = item.description ? escapeHtml(item.description) : '<span style="color:var(--danger);">(Not in Masterlist)</span>';
      var chips = item.entries.map(function(q, ei){
        return '<span class="entry-chip">' +
          '<input type="number" min="0" max="' + MAX_QTY + '" step="0.01" value="' + q + '" data-idx="' + idx + '" data-e="' + ei + '" class="qty-edit">' +
          '<span class="remove-btn" data-idx="' + idx + '" data-e="' + ei + '" title="Remove this entry">&times;</span>' +
        '</span>';
      }).join('');
      return '<div class="cart-item' + (item.unmatched ? ' unmatched' : '') + '">' +
        '<div class="cart-top">' +
          '<div style="min-width:0;">' +
            '<div class="cart-desc">' + descDisplay + '</div>' +
            '<div class="cart-sub">PLU ' + escapeHtml(item.plu) + ' &middot; ' + (item.category ? escapeHtml(item.category) : 'No category') + ' &middot; ' + (item.uom ? escapeHtml(item.uom) : '\u2014') + '</div>' +
          '</div>' +
          '<div class="cart-total"><small>Total' + (item.entries.length > 1 ? ' (' + item.entries.length + ' entries)' : '') + '</small><b>' + item.qty + '</b></div>' +
        '</div>' +
        '<div class="cart-entries"><span class="lbl">Entered:</span>' + chips + '</div>' +
      '</div>';
    }).join('');

    var recalc = function(it){
      it.qty = roundQty(it.entries.reduce(function(sum, q){ return sum + q; }, 0));
    };

    table.querySelectorAll('.qty-edit').forEach(function(input){
      input.addEventListener('change', function(){
        var idx = parseInt(input.dataset.idx, 10);
        var ei = parseInt(input.dataset.e, 10);
        var val = parseFloat(input.value);
        if(!val || val <= 0){
          input.value = cart[idx].entries[ei];
          return;
        }
        if(val > MAX_QTY){
          alert('Maximum quantity allowed is ' + MAX_QTY + '.');
          input.value = cart[idx].entries[ei];
          return;
        }
        cart[idx].entries[ei] = roundQty(val);
        recalc(cart[idx]);
        renderCart();
        saveDraft();
      });
    });

    table.querySelectorAll('.remove-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var idx = parseInt(btn.dataset.idx, 10);
        var ei = parseInt(btn.dataset.e, 10);
        var it = cart[idx];
        if(it.entries.length > 1){
          it.entries.splice(ei, 1);
          recalc(it);
        } else {
          cart.splice(idx, 1); // last entry for this PLU: drop the whole item
        }
        renderCart();
        saveDraft();
      });
    });
  }

  // ---------- New Entry: post-submit confirmation popup ----------
  // Summarises what was just submitted: items per category, and how many
  // PLUs were not in the masterlist (these go to IT Entry > Problem PLUs).
  function buildSubmitSummary(items, staff, supervisor, checkedBy){
    var perCat = {}, order = [], unmatched = 0, total = 0;
    items.forEach(function(it){
      total++;
      if(!it.category){ unmatched++; return; }
      if(!perCat[it.category]){ perCat[it.category] = { items: 0, qty: 0 }; order.push(it.category); }
      perCat[it.category].items++;
      perCat[it.category].qty += it.qty;
    });
    return { staff: staff, supervisor: supervisor, checkedBy: checkedBy, total: total, unmatched: unmatched, perCat: perCat, order: order };
  }

  function showSubmitSummary(sum, onClose){
    var old = document.getElementById('submitSummaryOverlay');
    if(old) old.parentNode.removeChild(old);

    var rows = sum.order.map(function(c){
      var r = sum.perCat[c];
      return '<tr><td>' + escapeHtml(c) + '</td><td style="text-align:right;">' + r.items + '</td></tr>';
    }).join('');
    if(sum.unmatched){
      rows += '<tr style="background:var(--danger-soft);"><td>Not in masterlist</td><td style="text-align:right;">' + sum.unmatched + '</td></tr>';
    }

    var overlay = document.createElement('div');
    overlay.id = 'submitSummaryOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999;';
    overlay.innerHTML =
      '<div class="card" style="max-width:420px;width:100%;margin:0;max-height:90vh;overflow:auto;">' +
        '<h2 style="margin-top:0;">' + (sum.queued ? '&#9203; Saved on this device' : '&#10003; Submitted successfully') + '</h2>' +
        (sum.queued ? '<div class="status err" style="margin:0 0 10px;">No connection. These items are stored safely and will be sent automatically when you are back online. Do not clear your browser data.</div>' : '') +
        '<div class="pending-meta"><b>' + escapeHtml(sum.staff) + '</b> &middot; ' + escapeHtml(sum.supervisor) + (sum.checkedBy ? ' &middot; ' + escapeHtml(sum.checkedBy) : '') + '</div>' +
        '<table style="margin-top:10px;"><thead><tr><th>Category</th><th style="text-align:right;">Items</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        '<div class="pending-meta" style="margin-top:10px;"><b>' + sum.total + '</b> item' + (sum.total === 1 ? '' : 's') + (sum.queued ? ' waiting to send' : ' submitted') + '</div>' +
        (sum.unmatched
          ? '<div class="status err" style="margin-top:10px;">' + sum.unmatched + ' PLU' + (sum.unmatched === 1 ? ' is' : 's are') + ' not in the masterlist. IT will review ' + (sum.unmatched === 1 ? 'it' : 'them') + ' before this can be printed.</div>'
          : '') +
        '<button class="btn btn-full" id="submitSummaryOk">OK</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('submitSummaryOk').addEventListener('click', function(){
      overlay.parentNode.removeChild(overlay);
      if(onClose) onClose();
    });
  }

  // ---------- Large-quantity check before submitting ----------
  // Any PLU whose total exceeds LARGE_QTY_LIMIT (10 EA / 10 KG) must be
  // explicitly confirmed — or corrected — before the submit goes through.
  var LARGE_QTY_LIMIT = 10;

  function submitCart(){
    if(!cart.length) return;
    var flagged = cart.some(function(it){ return it.qty > LARGE_QTY_LIMIT; });
    if(!flagged){ doSubmitCart(); return; }
    showLargeQtyConfirm(doSubmitCart);
  }

  function showLargeQtyConfirm(onProceed){
    var old = document.getElementById('largeQtyOverlay');
    if(old) old.parentNode.removeChild(old);

    var confirmed = {};   // plu -> true once ticked
    var editing = null;   // plu currently being edited

    var overlay = document.createElement('div');
    overlay.id = 'largeQtyOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:12px;z-index:9999;';
    document.body.appendChild(overlay);

    function flaggedItems(){ return cart.filter(function(it){ return it.qty > LARGE_QTY_LIMIT; }); }
    function close(){ overlay.parentNode.removeChild(overlay); }

    function render(){
      var items = flaggedItems();
      var allOk = items.every(function(it){ return confirmed[it.plu]; }) && editing === null;

      var rows = items.map(function(it){
        var isEd = editing === it.plu;
        var uom = it.uom ? ' ' + escapeHtml(it.uom) : '';
        var entriesTxt = it.entries.length > 1
          ? '<div class="cart-sub">Entered: ' + it.entries.map(function(q){ return q; }).join(' + ') + '</div>'
          : '';
        var body;
        if(isEd){
          body =
            '<div class="cart-entries"><span class="lbl">Edit:</span>' +
              it.entries.map(function(q, ei){
                return '<span class="entry-chip"><input type="number" min="0" max="' + MAX_QTY + '" step="0.01" value="' + q + '" data-e="' + ei + '" class="lq-edit"></span>';
              }).join('') +
            '</div>' +
            '<div class="btn-row" style="margin-top:8px;">' +
              '<button class="btn" data-act="save" data-plu="' + escapeHtml(it.plu) + '">Save</button>' +
              '<button class="btn ghost" data-act="cancel-edit">Cancel</button>' +
            '</div>' +
            '<div class="lq-err" style="color:var(--danger);font-size:12px;margin-top:6px;"></div>';
        } else {
          body =
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;flex-wrap:wrap;">' +
              '<button class="btn secondary" style="margin-top:0;" data-act="change" data-plu="' + escapeHtml(it.plu) + '">Change</button>' +
              '<label style="display:flex;align-items:center;gap:8px;margin:0;text-transform:none;font-size:13.5px;color:var(--text);cursor:pointer;">' +
                '<input type="checkbox" style="width:20px;height:20px;" data-act="tick" data-plu="' + escapeHtml(it.plu) + '"' + (confirmed[it.plu] ? ' checked' : '') + '> Quantity is correct' +
              '</label>' +
            '</div>';
        }
        return '<div class="cart-item">' +
          '<div class="cart-top">' +
            '<div style="min-width:0;"><div class="cart-desc">' + (it.description ? escapeHtml(it.description) : '(Not in Masterlist)') + '</div>' +
            '<div class="cart-sub">PLU ' + escapeHtml(it.plu) + '</div>' + entriesTxt + '</div>' +
            '<div class="cart-total"><small>Total</small><b>' + it.qty + uom + '</b></div>' +
          '</div>' + body +
        '</div>';
      }).join('');

      overlay.innerHTML =
        '<div class="card" style="max-width:460px;width:100%;margin:0;max-height:92vh;overflow:auto;">' +
          '<h2 style="margin-top:0;">&#9888; Please check these quantities</h2>' +
          '<div class="pending-meta">Quantities above <b>' + LARGE_QTY_LIMIT + '</b> need your confirmation. Tick each one if correct, or tap Change to fix it.</div>' +
          (rows || '<div class="status ok" style="margin-top:10px;">All quantities are now within the limit.</div>') +
          '<button class="btn btn-full" data-act="go"' + (allOk ? '' : ' disabled') + '>Confirm &amp; Submit</button>' +
          '<button class="btn ghost btn-full" data-act="back">Back to list</button>' +
        '</div>';
    }

    overlay.addEventListener('click', function(e){
      var t = e.target;
      var act = t.getAttribute && t.getAttribute('data-act');
      if(!act) return;
      var plu = t.getAttribute('data-plu');

      if(act === 'tick'){
        confirmed[plu] = t.checked;
        render();
      } else if(act === 'change'){
        editing = plu; render();
      } else if(act === 'cancel-edit'){
        editing = null; render();
      } else if(act === 'save'){
        var item = cart.find(function(c){ return c.plu === plu; });
        var inputs = overlay.querySelectorAll('.lq-edit');
        var vals = [];
        for(var i = 0; i < inputs.length; i++){
          var v = parseFloat(inputs[i].value);
          if(!v || v <= 0 || v > MAX_QTY){
            overlay.querySelector('.lq-err').textContent = 'Each quantity must be between 0.01 and ' + MAX_QTY + '.';
            return;
          }
          vals.push(roundQty(v));
        }
        item.entries = vals;
        item.qty = roundQty(vals.reduce(function(sum, q){ return sum + q; }, 0));
        confirmed[plu] = false; // changed: needs a fresh confirmation if still large
        editing = null;
        renderCart();
        saveDraft();
        render();
      } else if(act === 'back'){
        close();
      } else if(act === 'go'){
        if(flaggedItems().every(function(it){ return confirmed[it.plu]; })){
          close();
          onProceed();
        }
      }
    });

    render();
  }

  function doSubmitCart(){
    var statusEl = document.getElementById('submitStatus');
    if(!cart.length) return;

    document.getElementById('submitBtn').disabled = true;
    var summary = buildSubmitSummary(cart, sessionStaff, sessionSupervisor, sessionChecked);
    var staffNow = sessionStaff, supNow = sessionSupervisor, chkNow = sessionChecked, plantNow = currentOutletPlant;

    var finishReset = function(){
      document.getElementById('staffInput').value = '';
      document.getElementById('supervisorInput').value = '';
      document.getElementById('checkedByInput').value = '';
      document.getElementById('submitBtn').disabled = false;
      backToStep1();
    };

    // Offline: store it on this device and send automatically later.
    var queueIt = function(items, submissionId){
      outboxAdd({ plant: plantNow, staff: staffNow, supervisor: supNow, checkedBy: chkNow, items: items, submissionId: submissionId || null, queuedAt: new Date().toISOString() });
      var qsum = buildSubmitSummary(items, staffNow, supNow, chkNow);
      qsum.queued = true;
      statusEl.innerHTML = '';
      cart = [];
      clearDraft();
      renderCart();
      updateSyncUi();
      showSubmitSummary(qsum, finishReset);
    };

    if(!navigator.onLine){
      queueIt(cart.slice());
      return;
    }

    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Submitting...</div>';

    submitBadStockToSupabase(plantNow, staffNow, supNow, chkNow, cart)
      .then(function(res){
        statusEl.innerHTML = '';
        cart = [];
        clearDraft();
        renderCart();
        showSubmitSummary(summary, finishReset);
      })
      .catch(function(err){
        if(isNetworkError(err)){
          queueIt(err.remainingItems && err.remainingItems.length ? err.remainingItems : cart.slice(), err.submissionId);
          return;
        }
        statusEl.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
        document.getElementById('submitBtn').disabled = false;
      });
  }

  // ---------- Offline outbox (New Entry) ----------
  // A submission that cannot reach Supabase is kept in localStorage and
  // re-sent automatically (on reconnect, and on every 30s tick). Each
  // entry remembers its own outlet and original timestamp, so it lands
  // under the right plant and date even if sent hours later.
  var OUTBOX_KEY = 'shbn_bad_stock_outbox_v1';
  var outboxFlushing = false;

  function outboxLoad(){
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]') || []; } catch(e){ return []; }
  }
  function outboxSave(list){
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch(e){}
  }
  function outboxAdd(entry){
    entry.id = 'O' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
    var list = outboxLoad();
    list.push(entry);
    outboxSave(list);
  }
  function isNetworkError(err){
    if(!navigator.onLine) return true;
    return /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test((err && err.message) || '');
  }

  function flushOutbox(){
    if(outboxFlushing || !navigator.onLine) return Promise.resolve(0);
    var list = outboxLoad();
    if(!list.length) return Promise.resolve(0);
    outboxFlushing = true;
    var sent = 0;

    return list.reduce(function(chain, entry){
      return chain.then(function(){
        return submitBadStockToSupabase(entry.plant, entry.staff, entry.supervisor, entry.checkedBy || null, entry.items, entry.submissionId, entry.queuedAt)
          .then(function(){
            sent++;
            outboxSave(outboxLoad().filter(function(e){ return e.id !== entry.id; }));
          })
          .catch(function(err){
            // Keep what still needs sending (partial saves must not repeat).
            var cur = outboxLoad();
            cur.forEach(function(e){
              if(e.id === entry.id){
                if(err.remainingItems && err.remainingItems.length) e.items = err.remainingItems;
                if(err.submissionId) e.submissionId = err.submissionId;
                e.lastError = err.message;
              }
            });
            outboxSave(cur);
            if(isNetworkError(err)) throw err; // stop; try again later
          });
      });
    }, Promise.resolve())
    .catch(function(){ /* offline again: leave the rest queued */ })
    .then(function(){
      outboxFlushing = false;
      if(sent){
        syncNote = sent + ' queued submission' + (sent === 1 ? '' : 's') + ' sent';
        syncNoteUntil = Date.now() + 6000;
      }
      updateSyncUi();
      return sent;
    });
  }

  // ---------- Live auto-refresh + connection status ----------
  // Every 30s the IT Entry view re-reads its data quietly (no spinner, no
  // list blanking) and only redraws if something actually changed. It
  // pauses while the tab is hidden, while a field is being typed in, and
  // while a popup/overlay is open, so it never interrupts work.
  var AUTO_REFRESH_MS = 30000;
  var MASTERLIST_REFRESH_MS = 10 * 60 * 1000;
  var lastSyncAt = null;
  var nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  var lastMasterlistAt = Date.now();
  var syncInFlight = false;
  var syncFailed = false;
  var syncNote = '';
  var syncNoteUntil = 0;
  var currentTab = 'home';

  function userIsEditing(){
    var el = document.activeElement;
    if(!el || el === document.body) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }
  function overlayOpen(){
    var b = document.getElementById('busyOverlay');
    if(b && b.style.display !== 'none') return true;
    return !!document.getElementById('submitSummaryOverlay') || !!document.getElementById('confirmModalOverlay') || !!document.getElementById('largeQtyOverlay');
  }

  function updateSyncUi(){
    var box = document.getElementById('syncBox');
    var txt = document.getElementById('syncText');
    var btn = document.getElementById('forceRefreshBtn');
    if(!box || !txt) return;

    var queued = outboxLoad().length;
    var cls = '', text;
    if(!navigator.onLine){
      cls = 'offline';
      text = 'Offline · showing last loaded data';
    } else if(syncInFlight){
      cls = 'busy';
      text = 'Refreshing...';
    } else if(syncFailed){
      cls = 'warn';
      text = 'Could not refresh · retrying';
    } else if(lastSyncAt){
      var ago = Math.max(0, Math.round((Date.now() - lastSyncAt) / 1000));
      var next = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
      text = 'Live · updated ' + ago + 's ago';
      if(currentTab === 'it' || currentTab === 'git') text += ' · next in ' + next + 's';
    } else {
      text = 'Live';
    }
    if(queued) text += ' · ' + queued + ' queued to send';
    if(syncNote && Date.now() < syncNoteUntil) text += ' · ' + syncNote;
    box.className = 'sync-box ' + cls;
    txt.textContent = text;
    if(btn) btn.disabled = syncInFlight;
  }

  // Silent refresh of whatever the current screen shows.
  function autoRefreshNow(opts){
    opts = opts || {};
    if(syncInFlight) return Promise.resolve();
    syncInFlight = true;
    updateSyncUi();

    var tasks = [flushOutbox()];
    if(currentTab === 'it' && navigator.onLine){
      var o = { silent: true, force: !!opts.force };
      if(Date.now() - lastMasterlistAt > MASTERLIST_REFRESH_MS){ o.refreshMasterlist = true; }
      if(itEntrySubView === 'pending'){
        tasks.push(loadPendingEntries(o).then(function(){ if(o.refreshMasterlist) lastMasterlistAt = Date.now(); }));
      } else if(itEntrySubView === 'problem'){
        tasks.push(loadProblemPlus(o));
      } else if(itEntrySubView === 'completed'){
        tasks.push(loadCompletedEntries(null, null, o));
      }
    } else if(currentTab === 'git' && navigator.onLine){
      var go = { silent: true, force: !!opts.force };
      if(gdSubView === 'pending') tasks.push(gdLoadPending(go));
      else tasks.push(gdLoadCompleted(null, null, go));
    } else if(currentTab === 'home' && navigator.onLine){
      var homeOpts = { silent: true, force: !!opts.force };
      tasks.push(loadPendingEntries(homeOpts));
      tasks.push(loadProblemPlus(homeOpts));
      tasks.push(gdLoadPending(homeOpts).catch(function(){}));
    }

    return Promise.all(tasks)
      .then(function(){
        syncFailed = false;
        lastSyncAt = Date.now();
      })
      .catch(function(){
        syncFailed = true;
      })
      .then(function(){
        syncInFlight = false;
        nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
        updateSyncUi();
      });
  }

  // Force refresh: reloads everything — masterlist, categories, and every
  // IT Entry list (+ Admin list if unlocked) — and shows a wait overlay.
  function forceRefreshAll(){
    if(syncInFlight) return;
    if(!navigator.onLine){
      alert('You are offline. Data will refresh when the connection returns.');
      return;
    }
    syncInFlight = true;
    updateSyncUi();
    showBusy('Refreshing all data...');

    var o = { silent: true, force: true, refreshMasterlist: true };
    Promise.all([getMasterlistFromSupabase(), getCategoriesFromSupabase(), gdGetCategories().catch(function(){ return gdCategories; })])
      .then(function(r){
        gdCategories = r[2];
        gdPopulateCategorySelect();
        masterlist = r[0];
        masterlistByPlu = {};
        r[0].forEach(function(item){ masterlistByPlu[String(item.plu).trim()] = item; });
        appCategories = r[1];
        lastMasterlistAt = Date.now();
        updateCategorySubtitle();
        populateAdminCategoryDropdown();
        var tasks = [flushOutbox(), loadPendingEntries(o), loadProblemPlus(o)];
        var from = document.getElementById('completedDateFrom').value;
        var to = document.getElementById('completedDateTo').value;
        if(from && to) tasks.push(loadCompletedEntries(from, to, o));
        tasks.push(gdLoadPending(o).catch(function(){}));
        var gf = document.getElementById('gdCompletedDateFrom').value;
        var gt = document.getElementById('gdCompletedDateTo').value;
        if(gf && gt) tasks.push(gdLoadCompleted(gf, gt, o).catch(function(){}));
        if(adminUnlocked){ tasks.push(loadAdminPendingList()); tasks.push(gdLoadAdminPending()); }
        return Promise.all(tasks);
      })
      .then(function(){
        syncFailed = false;
        lastSyncAt = Date.now();
        syncNote = 'all data refreshed';
        syncNoteUntil = Date.now() + 4000;
      })
      .catch(function(){ syncFailed = true; })
      .then(function(){
        syncInFlight = false;
        nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
        hideBusy();
        updateSyncUi();
      });
  }

  // One 1-second heartbeat: updates the label, and triggers the 30s refresh
  // when due (unless paused for typing / popups / hidden tab).
  setInterval(function(){
    updateSyncUi();
    if(outletPending || document.hidden || syncInFlight) return;
    if(Date.now() < nextRefreshAt) return;
    if((currentTab === 'it' || currentTab === 'git') && (userIsEditing() || overlayOpen())) return; // try again next second
    autoRefreshNow();
  }, 1000);

  window.addEventListener('online', function(){ nextRefreshAt = 0; updateSyncUi(); });
  window.addEventListener('offline', function(){ updateSyncUi(); });
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden && Date.now() > nextRefreshAt - 1000) nextRefreshAt = 0;
  });

  // ================= IT ENTRY =================

  var lastPendingSig = null;

  // opts.silent: background refresh — no spinner/blanking, redraws only if
  // the data changed, and errors are thrown to the caller instead of
  // replacing the list. opts.force: redraw even if unchanged.
  // opts.refreshMasterlist: (silent only) also re-download the masterlist.
  function loadPendingEntries(opts){
    opts = opts || {};
    var silent = !!opts.silent;
    if(!silent){
      document.getElementById('categoryPicker').innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
      document.getElementById('pendingList').innerHTML = '';
      document.getElementById('pendingEmpty').style.display = 'none';
      document.getElementById('pendingCategoryEmpty').style.display = 'none';
    }

    // Refresh the masterlist cache first — picks up anything an admin just
    // added (potentially from a different device/session), so the
    // description/material/uom fallback in getPendingEntriesFromSupabase()
    // below has the latest data to work with.
    var masterStep = (silent && !opts.refreshMasterlist)
      ? Promise.resolve()
      : getMasterlistFromSupabase().then(function(list){
          masterlist = list;
          masterlistByPlu = {};
          list.forEach(function(item){ masterlistByPlu[String(item.plu).trim()] = item; });
        });

    return masterStep
      .then(function(){ return getPendingEntriesFromSupabase(); })
      .then(function(entries){
        var sig = JSON.stringify(entries);
        if(silent && !opts.force && sig === lastPendingSig) return; // nothing changed
        lastPendingSig = sig;

        // A batch the person just submitted is no longer "pending" on the
        // server, but its Print Here card must stay on screen. Keep those
        // through background/forced refreshes (a plain tab visit still
        // starts clean, as before).
        var kept = (silent || opts.force) ? pendingEntries.filter(function(b){
          var d = pendingDraft[pendingKey(b)];
          return d && d.submitted && !entries.some(function(e){ return pendingKey(e) === pendingKey(b); });
        }) : [];

        pendingEntries = entries.concat(kept);
        document.getElementById('pendingCount').textContent = entries.length;
        refreshHomeDashboard();

        entries.forEach(function(batch){
          var key = pendingKey(batch);
          if(!pendingDraft[key]){
            pendingDraft[key] = {
              items: batch.items.map(function(it){ return Object.assign({}, it, {isNew:false, dirty:false}); }),
              materialDocument: '',
              keyInBy: '',
              pluInput: '',
              qtyInput: '',
              pendingAddDescription: '', // required description for an unmatched PLU added via "Add PLU"
              submitted: null // holds printData once submitted
            };
          } else if(!editMode[key]){
            // Batch was already cached from an earlier load — refresh each
            // existing item's Description/Material/UOM from the server's
            // latest data (e.g. an admin just added a previously-missing
            // PLU to the Masterlist). Quantity is refreshed too UNLESS the
            // person has manually edited it in this session (it.dirty) —
            // a second New Entry submission on the same day merges into
            // this same row server-side (summing quantity), so an
            // untouched item should pick that up on refresh; only an
            // actual in-progress local edit should be protected from being
            // overwritten.
            var freshByPlu = {};
            batch.items.forEach(function(it){ freshByPlu[String(it.plu).trim()] = it; });
            var seenPlus = {};
            pendingDraft[key].items.forEach(function(it){
              seenPlus[String(it.plu).trim()] = true;
              if(it.isNew) return; // not yet saved to the sheet — nothing to refresh against
              var fresh = freshByPlu[String(it.plu).trim()];
              if(fresh){
                it.description = fresh.description;
                it.material = fresh.material;
                it.uom = fresh.uom;
                if(!it.dirty) it.qty = fresh.qty;
              }
            });
            // A separate submission (same day/staff/supervisor/category)
            // can merge a brand-new PLU into this batch server-side —
            // one the local cache has never seen before. Add it in now,
            // rather than only refreshing PLUs already present locally.
            batch.items.forEach(function(fresh){
              var pluKey = String(fresh.plu).trim();
              if(!seenPlus[pluKey]){
                pendingDraft[key].items.push(Object.assign({}, fresh, {isNew:false, dirty:false}));
              }
            });
          }
        });

        // if the previously selected category no longer has any entries, clear the selection
        if(selectedPendingCategory && !pendingEntries.some(function(b){ return b.category === selectedPendingCategory; })){
          selectedPendingCategory = null;
        }

        renderCategoryPicker();
        renderPendingListFiltered();
      })
      .catch(function(err){
        if(silent) throw err;
        document.getElementById('categoryPicker').innerHTML = '';
        document.getElementById('pendingList').innerHTML =
          '<div class="status err">Failed to load pending entries: ' + err.message + '</div>';
      });
  }

  function pendingKey(batch){ return batch.txnId; }

  function renderCategoryPicker(){
    var picker = document.getElementById('categoryPicker');
    picker.innerHTML = '';

    appCategories.forEach(function(cat){
      var count = pendingEntries.filter(function(b){ return b.category === cat; }).length;
      var chip = document.createElement('div');
      chip.className = 'category-chip' + (selectedPendingCategory === cat ? ' active' : '');
      chip.innerHTML = escapeHtml(cat) + ' <span class="count">' + count + '</span>';
      chip.onclick = function(){
        if(selectedPendingCategory !== cat && editingBlocked()) return;
        selectedPendingCategory = cat;
        renderCategoryPicker();
        renderPendingListFiltered();
      };
      picker.appendChild(chip);
    });
  }

  function renderPendingListFiltered(){
    renderPendingListFilteredBase();
    renderRevertedList();
  }

  // =====================================================================
  // Unpost Material Document (Admin) + Reverted Disposal tab
  // =====================================================================
  function fmFindBatch(key){
    return pendingEntries.find(function(b){ return pendingKey(b) === key; }) ||
           adminPendingEntries.find(function(b){ return pendingKey(b) === key; }) ||
           revFm.find(function(b){ return pendingKey(b) === key; });
  }
  function gdFindBatch(key){
    return gdPending.find(function(b){ return b.txnId === key; }) ||
           revGd.find(function(b){ return b.txnId === key; });
  }
  function fmBatchInfo(batch){
    return {
      category: batch.category, staff: batch.staff, supervisor: batch.supervisor, checkedBy: batch.checkedBy,
      status: batch.reverted ? 'reverted' : 'pending',
      entryDate: batch.entryDate, revertedAt: batch.revertedAt, revertedDoc: batch.revertedDoc, refNo: batch.refNo
    };
  }
  function revTypeTag(batch, label){
    if(!batch.reverted) return '';
    return '<span class="cat-tag" style="background:#fef3c7;color:#92400e;margin-right:6px;">' + escapeHtml(label) + '</span>';
  }
  function refTag(batch){
    return batch && batch.refNo ? '<span class="ref-tag" title="Reference Number">' + escapeHtml(batch.refNo) + '</span>' : '';
  }
  function revNoteHtml(batch){
    if(!batch.reverted) return '';
    return '<div class="status ok" style="margin:0 0 10px;background:#fffbeb;color:#92400e;border-color:#fde68a;">' +
      'Reverted' + (batch.revertedAt ? ' on ' + escapeHtml(formatDateDisplay(batch.revertedAt)) : '') +
      (batch.revertedDoc ? ' &middot; previous Material Document ' + escapeHtml(batch.revertedDoc) : '') +
      '. Edit if needed, post again in SAP, then enter the new Material Document and Submit.</div>';
  }

  function revSetBadge(){
    var n = revFm.filter(function(b){ var d = pendingDraft[pendingKey(b)]; return !(d && d.submitted); }).length +
            revGd.filter(function(b){ var d = gdDraft[b.txnId]; return !(d && d.submitted); }).length;
    var el = document.getElementById('recCountRv');
    if(el) el.textContent = String(n);
  }

  function revUpdateCount(){
    if(revLoaded){ revSetBadge(); return; }
    if(typeof sb === 'undefined' || !sb || !currentOutletPlant) return;
    Promise.all(['bad_stock_fresh_market', 'bad_stock_goods'].map(function(t){
      return sb.from(t).select('batch_id').eq('status', 'reverted').eq('plant', currentOutletPlant);
    })).then(function(rs){
      var seen = {};
      rs.forEach(function(r, i){ if(!r.error) (r.data || []).forEach(function(x){ seen[i + ':' + x.batch_id] = 1; }); });
      var el = document.getElementById('recCountRv');
      if(el) el.textContent = String(Object.keys(seen).length);
    }).catch(function(){});
  }

  function revLoad(){
    var ld = document.getElementById('rvLoading');
    if(ld && !revLoaded) ld.innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
    return Promise.all([getPendingEntriesFromSupabase('reverted'), gdGetPendingFromSupabase('reverted')]).then(function(rs){
      var fm = rs[0], gd = rs[1];
      fm.forEach(function(b){ b.reverted = true; });
      gd.forEach(function(b){ b.reverted = true; });
      var keptFm = revFm.filter(function(b){ var d = pendingDraft[pendingKey(b)]; return d && d.submitted && !fm.some(function(e){ return e.txnId === b.txnId; }); });
      var keptGd = revGd.filter(function(b){ var d = gdDraft[b.txnId]; return d && d.submitted && !gd.some(function(e){ return e.txnId === b.txnId; }); });
      revFm = fm.concat(keptFm);
      revGd = gd.concat(keptGd);
      fm.forEach(function(batch){
        var key = pendingKey(batch);
        if(!pendingDraft[key]){
          pendingDraft[key] = {
            items: batch.items.map(function(it){ return Object.assign({}, it, {isNew:false, dirty:false}); }),
            materialDocument: '', keyInBy: batch.keyInBy || '', pluInput: '', qtyInput: '',
            pendingAddDescription: '', submitted: null
          };
        }
      });
      gd.forEach(function(batch){
        var key = batch.txnId;
        if(!gdDraft[key]){
          gdDraft[key] = {
            items: batch.items.map(function(it){ return Object.assign({}, it, { dirty: false }); }),
            removedIds: [], materialDocument: '', keyInBy: batch.keyInBy || '', submitted: null
          };
        }
      });
      revLoaded = true;
      if(ld) ld.innerHTML = '';
      renderRevertedList();
    }).catch(function(err){
      if(ld) ld.innerHTML = '<div class="status err">Failed to load reverted records: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function renderRevertedList(){
    revSetBadge();
    var view = document.getElementById('rvTabView');
    if(!view || view.style.display === 'none') return;
    var fmSec = document.getElementById('rvFmSection'), gdSec = document.getElementById('rvGdSection');
    var emptyEl = document.getElementById('rvEmpty');
    fmSec.style.display = revFm.length ? 'block' : 'none';
    gdSec.style.display = revGd.length ? 'block' : 'none';
    emptyEl.style.display = (revFm.length || revGd.length || !revLoaded) ? 'none' : 'block';
    if(revFm.length) renderPendingList(revFm, 'rvFmList'); else document.getElementById('rvFmList').innerHTML = '';
    if(revGd.length) gdRenderPendingList(revGd, 'rvGdList'); else document.getElementById('rvGdList').innerHTML = '';
  }

  // ---------- Admin: search + unpost ----------
  var unpostFound = [];
  function unpostSearch(){
    var inp = document.getElementById('unpostDocInput');
    var st = document.getElementById('unpostStatus');
    var out = document.getElementById('unpostResult');
    var doc = inp.value.replace(/\D/g, '');
    inp.value = doc;
    out.innerHTML = '';
    if(!doc){ st.innerHTML = '<div class="status err">Enter a Material Document number (numbers only).</div>'; return; }
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Searching...</div>';
    var btn = document.getElementById('unpostSearchBtn'); btn.disabled = true;
    Promise.all(['bad_stock_fresh_market', 'bad_stock_goods'].map(function(t){
      return sb.from(t).select('*').eq('material_document', doc).eq('status', 'keyed_in').eq('plant', currentOutletPlant).order('id', { ascending: true });
    })).then(function(rs){
      rs.forEach(function(r){ if(r.error) throw new Error(r.error.message); });
      var groups = {}, order = [];
      [['fm', rs[0].data], ['gd', rs[1].data]].forEach(function(p){
        (p[1] || []).forEach(function(row){
          var k = p[0] + ':' + row.batch_id;
          if(!groups[k]){
            groups[k] = { type: p[0], id: row.batch_id, doc: doc, category: row.category, staff: row.staff, supervisor: row.supervisor,
              entryDate: row.entry_date, keyInBy: row.key_in_by, keyInDate: row.key_in_date, items: [] };
            order.push(k);
          }
          groups[k].items.push(p[0] === 'fm'
            ? { name: row.description || row.plu_code, qty: row.quantity, unit: row.uom }
            : { name: row.description || row.material, qty: row.quantity, unit: row.sales_unit });
        });
      });
      unpostFound = order.map(function(k){ return groups[k]; });
      if(!unpostFound.length){
        st.innerHTML = '<div class="status err">No completed record found for Material Document ' + escapeHtml(doc) + ' in this outlet.</div>';
        return;
      }
      st.innerHTML = '';
      out.innerHTML = unpostFound.map(function(b, i){
        return '<div class="card" style="margin-top:10px;">' +
          '<div class="pending-card-header"><div><span class="cat-tag" style="background:#fef3c7;color:#92400e;margin-right:6px;">' + (b.type === 'fm' ? 'Fresh Market' : 'Goods') + '</span><span class="cat-tag">' + escapeHtml(b.category) + '</span>' + refTag(b) + '</div>' +
          '<div class="pending-meta">' + escapeHtml(formatDateDisplay(b.entryDate)) + '</div></div>' +
          '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(b.staff) + '</b> &middot; ' + escapeHtml(b.supervisor) + '</div>' +
          '<div class="pending-meta">Material Document ' + escapeHtml(b.doc) + ' &middot; Key In By ' + escapeHtml(b.keyInBy || '-') +
            (b.keyInDate ? ' &middot; ' + escapeHtml(formatDateDisplay(b.keyInDate)) : '') + '</div>' +
          '<table><thead><tr><th>Item</th><th>Qty</th><th>Unit</th></tr></thead><tbody>' +
          b.items.map(function(it){ return '<tr><td>' + escapeHtml(it.name) + '</td><td>' + escapeHtml(String(it.qty)) + '</td><td>' + escapeHtml(it.unit || '') + '</td></tr>'; }).join('') +
          '</tbody></table>' +
          '<button class="btn btn-full" style="background:#b45309;" onclick="unpostConfirm(' + i + ')">Unpost</button>' +
          '</div>';
      }).join('');
    }).catch(function(err){
      st.innerHTML = '<div class="status err">Error: ' + escapeHtml(err.message) + '</div>';
    }).then(function(){ btn.disabled = false; });
  }

  function unpostConfirm(i){
    var b = unpostFound[i];
    if(!b) return;
    if(!confirm('Unpost Material Document ' + b.doc + '?\n\n' + (b.type === 'fm' ? 'Fresh Market' : 'Goods') + ' - ' + b.category + ' - ' + b.staff +
        '\n' + b.items.length + ' item' + (b.items.length === 1 ? '' : 's') +
        '\n\nThis record will move to Reverted Disposal so it can be edited and submitted again. The material document is cleared here only; reverse it in SAP separately.')) return;
    var tbl = b.type === 'fm' ? 'bad_stock_fresh_market' : 'bad_stock_goods';
    var st = document.getElementById('unpostStatus');
    showBusy('Unposting...');
    sb.from(tbl).update({
      status: 'reverted', reverted_at: new Date().toISOString(), reverted_doc: b.doc, material_document: null, key_in_date: null
    }).eq('batch_id', b.id).eq('status', 'keyed_in').eq('plant', currentOutletPlant).select('id').then(function(res){
      hideBusy();
      if(res.error) throw new Error(res.error.message);
      if(!res.data || !res.data.length) throw new Error('Nothing was changed. The record may already have been unposted.');
      unpostFound.splice(i, 1);
      document.getElementById('unpostResult').innerHTML = '';
      document.getElementById('unpostDocInput').value = '';
      st.innerHTML = '<div class="status ok">Unposted. The record is now in Reverted Disposal. <a href="#" onclick="showTab(\'rv\'); return false;">Open Reverted Disposal</a></div>';
      revLoaded = false;
      revUpdateCount();
    }).catch(function(err){
      hideBusy();
      var m = err.message || '';
      if(/reverted_at|reverted_doc|check constraint/i.test(m)) m += ' (run unpost-reverted-schema.sql in Supabase first)';
      st.innerHTML = '<div class="status err">Error: ' + escapeHtml(m) + '</div>';
    });
  }

  function renderPendingListFilteredBase(){
    var container = document.getElementById('pendingList');
    var emptyEl = document.getElementById('pendingEmpty');
    var categoryEmptyEl = document.getElementById('pendingCategoryEmpty');

    if(!selectedPendingCategory){
      container.innerHTML = '';
      emptyEl.style.display = 'none';
      categoryEmptyEl.style.display = 'block';
      return;
    }
    categoryEmptyEl.style.display = 'none';

    var filtered = pendingEntries.filter(function(b){ return b.category === selectedPendingCategory; });

    if(!filtered.length){
      container.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    renderPendingList(filtered);
  }

  // ---------- IT Entry: Pending / Completed sub-tabs ----------

  function switchItSubView(view){
    if(view !== itEntrySubView && editingBlocked()) return;
    itEntrySubView = view;
    document.getElementById('pendingSubView').style.display = view === 'pending' ? 'block' : 'none';
    document.getElementById('completedSubView').style.display = view === 'completed' ? 'block' : 'none';
    document.getElementById('problemSubView').style.display = view === 'problem' ? 'block' : 'none';
    document.getElementById('itSubViewHeaderPending').style.display = view === 'pending' ? 'block' : 'none';
    document.getElementById('itSubViewHeaderCompleted').style.display = view === 'completed' ? 'block' : 'none';
    document.getElementById('itSubViewHeaderProblem').style.display = view === 'problem' ? 'block' : 'none';
    document.getElementById('itSubTabPending').classList.toggle('active', view === 'pending');
    document.getElementById('itSubTabCompleted').classList.toggle('active', view === 'completed');
    document.getElementById('itSubTabProblem').classList.toggle('active', view === 'problem');

    if(view === 'completed'){
      initCompletedDateInputs();
    } else if(view === 'problem'){
      loadProblemPlus();
    }
  }

  // Pre-fills Date From/To with a sensible starting range (last 30 days)
  // the first time Completed is opened, without fetching anything — the
  // person still has to press Run themselves to actually load results,
  // same as picking a fresh range on any later visit.
  function initCompletedDateInputs(){
    var fromEl = document.getElementById('completedDateFrom');
    var toEl = document.getElementById('completedDateTo');
    if(fromEl.value && toEl.value) return; // already set from an earlier visit this session

    var today = new Date();
    var from = new Date();
    from.setDate(from.getDate() - 30);

    function toDateInputValue(d){
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    }

    fromEl.value = toDateInputValue(from);
    toEl.value = toDateInputValue(today);
  }

  function runCompletedDateRange(){
    var fromVal = document.getElementById('completedDateFrom').value;
    var toVal = document.getElementById('completedDateTo').value;
    var statusEl = document.getElementById('completedDateStatus');

    if(!fromVal || !toVal){
      statusEl.innerHTML = '<div class="status err">Please select both Date From and Date To.</div>';
      return;
    }
    if(fromVal > toVal){
      statusEl.innerHTML = '<div class="status err">Date From must be on or before Date To.</div>';
      return;
    }

    statusEl.innerHTML = '';
    loadCompletedEntries(fromVal, toVal);
  }

  var lastCompletedSig = null;

  function loadCompletedEntries(fromVal, toVal, opts){
    opts = opts || {};
    var silent = !!opts.silent;
    // Reuses whatever's currently in the date inputs if called without
    // explicit dates (e.g. Refresh button) — Run is only needed to change
    // the range, not to reload the same one.
    fromVal = fromVal || document.getElementById('completedDateFrom').value;
    toVal = toVal || document.getElementById('completedDateTo').value;
    if(!fromVal || !toVal) return;

    if(!silent){
      document.getElementById('completedCategoryPicker').innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
      document.getElementById('completedList').innerHTML = '';
      document.getElementById('completedEmpty').style.display = 'none';
      document.getElementById('completedCategoryEmpty').style.display = 'none';
    }

    return getCompletedEntriesFromSupabase(fromVal, toVal)
      .then(function(entries){
        var sig = fromVal + '|' + toVal + '|' + JSON.stringify(entries);
        if(silent && !opts.force && sig === lastCompletedSig) return;
        lastCompletedSig = sig;
        completedEntries = entries;
        document.getElementById('completedCount').textContent = entries.length;

        if(selectedCompletedCategory && !entries.some(function(b){ return b.category === selectedCompletedCategory; })){
          selectedCompletedCategory = null;
        }

        renderCompletedCategoryPicker();
        renderCompletedListFiltered();
      })
      .catch(function(err){
        if(silent) throw err;
        document.getElementById('completedCategoryPicker').innerHTML = '';
        document.getElementById('completedList').innerHTML =
          '<div class="status err">Failed to load completed entries: ' + err.message + '</div>';
      });
  }

  function renderCompletedCategoryPicker(){
    var picker = document.getElementById('completedCategoryPicker');
    picker.innerHTML = '';

    appCategories.forEach(function(cat){
      var count = completedEntries.filter(function(b){ return b.category === cat; }).length;
      var chip = document.createElement('div');
      chip.className = 'category-chip' + (selectedCompletedCategory === cat ? ' active' : '');
      chip.innerHTML = escapeHtml(cat) + ' <span class="count">' + count + '</span>';
      chip.onclick = function(){
        selectedCompletedCategory = cat;
        renderCompletedCategoryPicker();
        renderCompletedListFiltered();
      };
      picker.appendChild(chip);
    });
  }

  function renderCompletedListFiltered(){
    var container = document.getElementById('completedList');
    var emptyEl = document.getElementById('completedEmpty');
    var categoryEmptyEl = document.getElementById('completedCategoryEmpty');

    if(!selectedCompletedCategory){
      container.innerHTML = '';
      emptyEl.style.display = 'none';
      categoryEmptyEl.style.display = 'block';
      return;
    }
    categoryEmptyEl.style.display = 'none';

    var filtered = completedEntries.filter(function(b){ return b.category === selectedCompletedCategory; });

    if(!filtered.length){
      container.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    container.innerHTML = '';
    filtered.forEach(function(batch){
      var key = batch.txnId;

      // Reuse pendingDraft + printBatch() as-is by populating the same
      // populating the same shape those functions already expect, with
      // "submitted" always set — Completed entries are read-only, no
      // Save Changes / qty editing offered here.
      pendingDraft[key] = {
        items: batch.items,
        materialDocument: batch.materialDocument,
        keyInBy: batch.keyInBy,
        pluInput: '',
        qtyInput: '',
        submitted: {
          date: batch.dateDisplay,
          time: '',
          category: batch.category,
          staff: batch.staff,
          supervisor: batch.supervisor,
          checkedBy: batch.checkedBy || '',
          refNo: batch.refNo || '',
          materialDocument: batch.materialDocument,
          keyInBy: batch.keyInBy,
          items: batch.items
        }
      };

      var safeKey = key.replace(/[^a-zA-Z0-9]/g,'_');
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="pending-card-header">' +
          '<div><span class="cat-tag">' + escapeHtml(batch.category) + '</span>' + refTag(batch) + '</div>' +
          '<div class="pending-meta">' + escapeHtml(batch.dateDisplay) + '</div>' +
        '</div>' +
        '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(batch.staff) + '</b> &middot; ' + escapeHtml(batch.supervisor) + (batch.checkedBy ? ' &middot; ' + escapeHtml(batch.checkedBy) : '') + '</div>' +
        '<div class="status ok" style="margin-top:12px;">Completed &middot; Material Document ' + escapeHtml(batch.materialDocument) + '</div>' +
        '<button class="btn secondary btn-full" onclick="printBatch(\'' + key + '\')">Print Here</button>';
      container.appendChild(card);
    });
  }

  // Edit / Print buttons shown in the card header (Fresh Market and Goods).
  function editActionsHtml(type, key, editing){
    var printFn = type === 'gd' ? 'gdPrintBatch' : 'printBatch';
    if(editing){
      return '<div class="pending-actions"><span class="edit-badge">Editing</span>' +
        '<button class="mini-btn" disabled title="Save or cancel your edit first">Print</button></div>';
    }
    return '<div class="pending-actions">' +
      '<button class="mini-btn" onclick="event.stopPropagation(); startEdit(\'' + type + '\', \'' + key + '\')">Edit</button>' +
      '<button class="mini-btn" onclick="event.stopPropagation(); ' + printFn + '(\'' + key + '\')">Print</button>' +
    '</div>';
  }

  // ---------- Pending cards: expand / collapse ----------
  // With several transactions in one category the page gets very long, so
  // each pending card can fold down to its header (category, date, staff,
  // supervisor). State is kept per batch so it survives re-renders; the
  // default is collapsed when a category has 2+ transactions, expanded
  // when there is only one.
  var pendingCollapsedState = {};

  function isPendingCollapsed(key, batchCount){
    if(pendingCollapsedState[key] !== undefined) return pendingCollapsedState[key];
    return batchCount > 1;
  }

  function togglePendingCard(headerEl, key){
    var card = headerEl.parentNode;
    var body = card.querySelector('.pending-body');
    if(!body) return;
    var nowCollapsed = body.style.display !== 'none';
    body.style.display = nowCollapsed ? 'none' : '';
    pendingCollapsedState[key] = nowCollapsed;
    var chev = headerEl.querySelector('.pending-chevron');
    if(chev) chev.textContent = nowCollapsed ? '\u25B8' : '\u25BE';
  }

  function renderPendingList(batchesToRender, containerId){
    var container = document.getElementById(containerId || 'pendingList');
    container.innerHTML = '';

    batchesToRender.forEach(function(batch){
      var key = pendingKey(batch);
      var draft = pendingDraft[key];
      var card = document.createElement('div');
      card.className = 'card';
      card.id = 'pcard_' + key.replace(/[^a-zA-Z0-9]/g,'_');

      if(draft.submitted){
        delete editMode[key];
        card.innerHTML =
          '<div class="pending-card-header">' +
            '<div><span class="cat-tag">' + escapeHtml(batch.category) + '</span>' + refTag(batch) + '</div>' +
            '<div class="pending-meta">' + escapeHtml(batch.dateDisplay) + '</div>' +
          '</div>' +
          '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(batch.staff) + '</b> &middot; ' + escapeHtml(batch.supervisor) + (batch.checkedBy ? ' &middot; ' + escapeHtml(batch.checkedBy) : '') + '</div>' +
          '<div class="status ok" style="margin-top:12px;">Completed &middot; Material Document ' + escapeHtml(draft.materialDocument) + '</div>' +
          '<button class="btn secondary btn-full" onclick="printBatch(\'' + key + '\')">Print Here</button>';
        container.appendChild(card);
        return;
      }

      var editing = !!editMode[key];
      var itemsHtml = draft.items.map(function(item, idx){
        var descDisplay = item.unmatched
          ? escapeHtml(item.description) + ' <span style="color:var(--danger);font-size:11px;">(Not in Masterlist)</span>'
          : (item.description ? escapeHtml(item.description) : '<span style="color:var(--danger);">(Not in Masterlist)</span>');
        var rowStyle = item.unmatched ? ' style="background:var(--danger-soft);"' : '';
        return '<tr' + rowStyle + '>' +
          '<td>' + descDisplay + '</td>' +
          '<td>' + escapeHtml(item.plu) + '</td>' +
          '<td>' + escapeHtml(item.uom || '\u2014') + '</td>' +
          '<td>' + (editing
            ? '<input type="number" min="0" max="' + MAX_QTY + '" step="0.01" value="' + item.qty + '" data-key="' + key + '" data-idx="' + idx + '" class="pending-qty-edit">'
            : escapeHtml(String(item.qty))) + '</td>' +
          '<td>' + (editing ? '<span class="remove-btn" data-key="' + key + '" data-idx="' + idx + '" onclick="removePendingItem(this)">&times;</span>' : '') + '</td>' +
        '</tr>';
      }).join('');

      var pendingSafeKey = key.replace(/[^a-zA-Z0-9]/g,'_');

      var collapsed = isPendingCollapsed(key, batchesToRender.length);
      card.innerHTML =
        '<div class="pending-toggle" onclick="togglePendingCard(this, \'' + key + '\')">' +
          '<div class="pending-card-header">' +
            '<div>' + revTypeTag(batch, 'Fresh Market') + '<span class="cat-tag">' + escapeHtml(batch.category) + '</span>' + refTag(batch) + '</div>' +
            '<div class="pending-meta">' + escapeHtml(batch.dateDisplay) + ' <span class="pending-chevron">' + (collapsed ? '\u25B8' : '\u25BE') + '</span></div>' +
          '</div>' +
          '<div class="pending-meta pending-meta-row" style="margin-top:6px;"><span><b>' + escapeHtml(batch.staff) + '</b> &middot; ' + escapeHtml(batch.supervisor) + (batch.checkedBy ? ' &middot; ' + escapeHtml(batch.checkedBy) : '') +
            ' &middot; ' + draft.items.length + ' item' + (draft.items.length === 1 ? '' : 's') + '</span>' + editActionsHtml('fm', key, editing) + '</div>' +
        '</div>' +
        '<div class="pending-body"' + (collapsed ? ' style="display:none;"' : '') + '>' +
        revNoteHtml(batch) +
        '<table>' +
          '<thead><tr><th>Description</th><th>PLU</th><th>UOM</th><th>Qty</th><th></th></tr></thead>' +
          '<tbody>' + itemsHtml + '</tbody>' +
        '</table>' +
        (editing
          ? '<div class="add-item-row">' +
              '<div><label>Add PLU</label><input type="text" class="pending-plu-input" data-key="' + key + '" placeholder="PLU code"></div>' +
              '<div style="flex:0 0 90px;"><label>Qty</label><input type="number" min="0" max="' + MAX_QTY + '" step="0.01" class="pending-qty-input" data-key="' + key + '" placeholder="0"></div>' +
              '<button class="btn ghost" style="margin-top:0;" onclick="addPendingItem(\'' + key + '\')">Add</button>' +
            '</div>' +
            '<div id="pendingAddPreview_' + pendingSafeKey + '"></div>' +
            '<div id="pendingAddStatus_' + pendingSafeKey + '"></div>' +
            '<button class="btn secondary btn-full" onclick="saveDraftChanges(\'' + key + '\')">Save Changes</button>' +
            '<button class="btn ghost btn-full" onclick="cancelEdit(\'fm\', \'' + key + '\')">Cancel</button>'
          : '') +
        '<div id="pendingSaveStatus_' + pendingSafeKey + '"></div>' +
        sapCopySectionHtml(key, draft) +
        '<hr class="divider">' +
        '<label>Material Document</label>' +
        '<input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" class="pending-material-doc" data-key="' + key + '" value="' + escapeHtml(draft.materialDocument) + '" placeholder="Enter material document number (numbers only)">' +
        '<label>Key In By</label>' +
        '<input type="text" class="pending-key-in-by" data-key="' + key + '" value="' + escapeHtml(draft.keyInBy) + '" placeholder="Enter your name">' +
        '<button class="btn btn-full" onclick="submitPendingBatch(\'' + key + '\')">Submit</button>' +
        '<div id="pendingSubmitStatus_' + pendingSafeKey + '"></div>' +
        '</div>';

      container.appendChild(card);
    });

    // wire up qty edits
    container.querySelectorAll('.pending-qty-edit').forEach(function(input){
      input.addEventListener('change', function(){
        var key = input.dataset.key;
        var idx = parseInt(input.dataset.idx, 10);
        var val = parseFloat(input.value);
        if(!val || val <= 0){
          input.value = pendingDraft[key].items[idx].qty;
          return;
        }
        if(val > MAX_QTY){
          alert('Maximum quantity allowed is ' + MAX_QTY + '.');
          input.value = pendingDraft[key].items[idx].qty;
          return;
        }
        val = roundQty(val);
        pendingDraft[key].items[idx].qty = val;
        pendingDraft[key].items[idx].dirty = true;
        input.value = val;
      });
    });

    // wire up material document / key in by fields
    container.querySelectorAll('.pending-material-doc').forEach(function(input){
      input.addEventListener('input', function(){
        var digits = input.value.replace(/\D/g, ''); // numbers only (also cleans pasted text)
        if(digits !== input.value) input.value = digits;
        pendingDraft[input.dataset.key].materialDocument = digits;
      });
    });
    container.querySelectorAll('.pending-key-in-by').forEach(function(input){
      input.addEventListener('input', function(){
        pendingDraft[input.dataset.key].keyInBy = input.value;
      });
    });
    container.querySelectorAll('.pending-plu-input').forEach(function(input){
      input.addEventListener('input', function(){
        pendingDraft[input.dataset.key].pluInput = input.value;
        pendingDraft[input.dataset.key].pendingAddDescription = ''; // new PLU typed — any earlier description no longer applies
        renderPendingAddPreview(input.dataset.key);
      });
    });
    container.querySelectorAll('.pending-qty-input').forEach(function(input){
      input.addEventListener('input', function(){ pendingDraft[input.dataset.key].qtyInput = input.value; });
    });
  }

  // ---------- Copy to SAP (chunked clipboard export) ----------
  // Lets IT staff copy a pending batch's line items — Material, Qty, UOM,
  // Plant, SLoc, Reason, in that exact column order — as tab-separated
  // text, ready to paste directly into an SAP GUI grid. Batches can run
  // well past one screen, so this chunks the copy with Prev/Next
  // navigation rather than one giant paste. Chunk size is adjustable per
  // batch (defaults to 7) via the number input in the section itself.
  var DEFAULT_SAP_CHUNK_SIZE = 7;

  function sapTotalChunks(draft){
    var size = draft.sapChunkSize || DEFAULT_SAP_CHUNK_SIZE;
    return Math.max(1, Math.ceil(draft.items.length / size));
  }

  function sapCopySectionHtml(key, draft){
    if(draft.sapChunkSize === undefined) draft.sapChunkSize = DEFAULT_SAP_CHUNK_SIZE;
    if(draft.sapChunkIndex === undefined) draft.sapChunkIndex = 0;
    var totalChunks = sapTotalChunks(draft);
    if(draft.sapChunkIndex >= totalChunks) draft.sapChunkIndex = totalChunks - 1;
    if(draft.sapChunkIndex < 0) draft.sapChunkIndex = 0;

    var size = draft.sapChunkSize;
    var start = draft.sapChunkIndex * size;
    var chunkItems = draft.items.slice(start, start + size);
    var safeKey = key.replace(/[^a-zA-Z0-9]/g,'_');

    var copiedMap = draft.sapCopied || {};
    var thisCopied = !!copiedMap[draft.sapChunkIndex];
    var copiedCount = Object.keys(copiedMap).length;

    var rowsHtml = chunkItems.map(function(it){
      return '<tr>' +
        '<td>' + escapeHtml(it.material || '') + '</td>' +
        '<td>' + escapeHtml(String(it.qty)) + '</td>' +
        '<td>' + escapeHtml(it.uom || '') + '</td>' +
        '<td>' + escapeHtml(currentOutletPlant) + '</td><td>1000</td><td>2</td>' +
        '</tr>';
    }).join('');

    return '<hr class="divider">' +
      '<h2><span class="step-badge">&#128203;</span> Copy to SAP</h2>' +
      '<div class="pending-meta" style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">' +
        '<span>Batch ' + (draft.sapChunkIndex + 1) + ' of ' + totalChunks +
        ' &middot; ' + chunkItems.length + ' row' + (chunkItems.length === 1 ? '' : 's') +
        (thisCopied ? ' &middot; <b style="color:var(--ok, #2f7d4f);">&#10003; Copied</b>' : '') +
        ' &middot; ' + copiedCount + '/' + totalChunks + ' copied</span>' +
        '<span style="display:flex;align-items:center;gap:6px;">' +
          '<label style="margin:0;text-transform:none;font-size:12.5px;">Rows per batch</label>' +
          '<input type="number" min="1" max="50" step="1" value="' + size + '" style="width:60px;padding:5px 8px;" ' +
            'onchange="setSapChunkSize(\'' + key + '\', this.value)">' +
        '</span>' +
      '</div>' +
      '<table><thead><tr><th>Material</th><th>Qty</th><th>UOM</th><th>Plant</th><th>SLoc</th><th>Reason</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table>' +
      '<div class="btn-row">' +
        '<button class="btn ghost" ' + (draft.sapChunkIndex <= 0 ? 'disabled' : '') + ' onclick="sapChunkPrev(\'' + key + '\')">Prev</button>' +
        '<button class="btn secondary" onclick="copySapChunk(\'' + key + '\')">' + (thisCopied ? 'Copy Again' : 'Copy Batch') + '</button>' +
        '<button class="btn ghost" ' + (draft.sapChunkIndex >= totalChunks - 1 ? 'disabled' : '') + ' onclick="sapChunkNext(\'' + key + '\')">Next</button>' +
      '</div>' +
      '<div id="sapCopyStatus_' + safeKey + '">' +
        (draft.sapNotice ? '<div class="status ok">' + escapeHtml(draft.sapNotice) + '</div>' : '') +
      '</div>';
  }

  function setSapChunkSize(key, value){
    var draft = pendingDraft[key];
    var size = parseInt(value, 10);
    if(!size || size < 1) size = 1;
    draft.sapChunkSize = size;
    draft.sapChunkIndex = 0; // re-chunking invalidates the old page position
    draft.sapCopied = {};    // ...and any "copied" marks
    draft.sapNotice = '';
    renderPendingListFiltered();
  }

  function sapChunkPrev(key){
    var draft = pendingDraft[key];
    draft.sapChunkIndex = Math.max(0, (draft.sapChunkIndex || 0) - 1);
    draft.sapNotice = '';
    renderPendingListFiltered();
  }

  function sapChunkNext(key){
    var draft = pendingDraft[key];
    var totalChunks = sapTotalChunks(draft);
    draft.sapChunkIndex = Math.min(totalChunks - 1, (draft.sapChunkIndex || 0) + 1);
    draft.sapNotice = '';
    renderPendingListFiltered();
  }

  function copySapChunk(key){
    var draft = pendingDraft[key];
    var size = draft.sapChunkSize || DEFAULT_SAP_CHUNK_SIZE;
    var start = (draft.sapChunkIndex || 0) * size;
    var chunkItems = draft.items.slice(start, start + size);
    var safeKey = key.replace(/[^a-zA-Z0-9]/g,'_');
    var statusEl = document.getElementById('sapCopyStatus_' + safeKey);

    var tsv = chunkItems.map(function(it){
      return [it.material || '', it.qty, it.uom || '', currentOutletPlant, '1000', '2'].join('\t');
    }).join('\n');

    navigator.clipboard.writeText(tsv)
      .then(function(){
        if(!draft.sapCopied) draft.sapCopied = {};
        var copiedIdx = draft.sapChunkIndex || 0;
        draft.sapCopied[copiedIdx] = true;
        var total = sapTotalChunks(draft);
        draft.sapNotice = 'Copied batch ' + (copiedIdx + 1) + ' of ' + total + ' (' + chunkItems.length + ' row' + (chunkItems.length === 1 ? '' : 's') + ').';
        if(copiedIdx < total - 1){
          draft.sapChunkIndex = copiedIdx + 1; // auto-advance, ready for the next paste
          draft.sapNotice += ' Moved to batch ' + (copiedIdx + 2) + '.';
        } else {
          draft.sapNotice += ' That was the last batch.';
        }
        renderPendingListFiltered();
      })
      .catch(function(err){
        statusEl.innerHTML = '<div class="status err">Copy failed: ' + err.message + '</div>';
      });
  }

  function removePendingItem(el){
    var key = el.dataset.key;
    var idx = parseInt(el.dataset.idx, 10);
    if(pendingDraft[key].items.length <= 1){
      alert('A batch must have at least one item.');
      return;
    }
    var it = pendingDraft[key].items[idx];
    var ok = confirm(
      'Remove this item?\n\n' +
      (it.description || '(Not in Masterlist)') + '\n' +
      'PLU ' + it.plu + ' \u00B7 Qty ' + it.qty + ' ' + (it.uom || '') + '\n\n' +
      'It will be removed when you tap Save Changes or Submit.'
    );
    if(!ok) return;
    pendingDraft[key].items.splice(idx, 1);
    renderPendingListFiltered();
  }

  // Live preview under IT Entry's "Add PLU" field — mirrors New Entry's
  // lookupPlu() preview so staff can see the Description/UOM before
  // committing the item, instead of only finding out after clicking Add.
  // Also runs scanned codes through the same weighing-scale barcode
  // detection as New Entry, so a scan here behaves identically.
  function renderPendingAddPreview(key){
    var draft = pendingDraft[key];
    var previewEl = document.getElementById('pendingAddPreview_' + key.replace(/[^a-zA-Z0-9]/g,'_'));
    if(!previewEl) return;

    var raw = (draft.pluInput || '').trim();
    if(!raw){
      previewEl.innerHTML = '';
      return;
    }

    var plu = extractPluFromBarcode(raw);
    var match = masterlistByPlu[plu];

    if(match){
      previewEl.innerHTML =
        '<div class="lookup-preview">' +
        '<div class="row"><span>Description</span><b>' + escapeHtml(match.description) + '</b></div>' +
        '<div class="row"><span>UOM</span><b>' + escapeHtml(match.uom) + '</b></div>' +
        '</div>';
    } else {
      var safeKey = key.replace(/[^a-zA-Z0-9]/g,'_');
      previewEl.innerHTML =
        '<div class="lookup-preview notfound">' +
        'PLU "' + escapeHtml(plu) + '" was not found in the Masterlist. Please describe the item before adding it — admin can refine the details later in Problem PLUs.' +
        '<label style="margin-top:10px;">Description <span style="color:var(--danger);">*</span></label>' +
        '<input type="text" id="pendingUnmatchedDesc_' + safeKey + '" value="' + escapeHtml(draft.pendingAddDescription || '') + '" placeholder="Describe this item">' +
        '</div>';

      var descInput = document.getElementById('pendingUnmatchedDesc_' + safeKey);
      descInput.addEventListener('input', function(){
        pendingDraft[key].pendingAddDescription = descInput.value.trim();
      });
    }
  }

  function addPendingItem(key){
    var draft = pendingDraft[key];
    var plu = extractPluFromBarcode((draft.pluInput || '').trim());
    var qty = parseFloat(draft.qtyInput);
    var statusEl = document.getElementById('pendingAddStatus_' + key.replace(/[^a-zA-Z0-9]/g,'_'));

    if(!plu){ statusEl.innerHTML = '<div class="status err">Enter a PLU code.</div>'; return; }
    if(!qty || qty <= 0){ statusEl.innerHTML = '<div class="status err">Enter a valid quantity.</div>'; return; }
    if(qty > MAX_QTY){ statusEl.innerHTML = '<div class="status err">Maximum quantity allowed is ' + MAX_QTY + '.</div>'; return; }
    qty = roundQty(qty); // accepts up to 3 decimals typed, stores only 2

    var match = masterlistByPlu[plu];
    var description = match ? match.description : (draft.pendingAddDescription || '').trim();

    if(!match && !description){
      statusEl.innerHTML = '<div class="status err">Please enter a description for this PLU before adding it.</div>';
      return;
    }

    var already = draft.items.find(function(i){ return i.plu === plu; });
    if(already){
      // Duplicate PLU: quantities add up, rounded back to 2 decimals — not
      // re-capped at 99.99, since a legitimate running total can exceed it.
      already.qty = roundQty(already.qty + qty);
    } else {
      draft.items.push({
        plu: plu,
        description: description,
        material: match ? match.material : '',
        uom: match ? match.uom : '',
        qty: qty,
        isNew: true,
        unmatched: !match
      });
    }

    draft.pluInput = '';
    draft.qtyInput = '';
    draft.pendingAddDescription = '';
    statusEl.innerHTML = '';
    renderPendingListFiltered();
  }

  // Saves the current in-memory items for a still-pending batch to the sheet.
  // Returns a promise so both Save Changes and Send to Print Station (which
  // needs the sheet to reflect the latest edits before queuing) can reuse it.
  function persistPendingDraft(key){
    var draft = pendingDraft[key];
    var batch = fmFindBatch(key);
    if(!draft.items.length) return Promise.reject(new Error('A batch must have at least one item.'));

    return saveITEntryDraftToSupabase(batch.txnId, draft.items, fmBatchInfo(batch)).then(function(){
      draft.items.forEach(function(it){ it.isNew = false; it.dirty = false; });
    });
  }

  function saveDraftChanges(key){
    var draft = pendingDraft[key];
    var safeKey = key.replace(/[^a-zA-Z0-9]/g,'_');
    var statusEl = document.getElementById('pendingSaveStatus_' + safeKey);

    if(!draft.items.length){
      statusEl.innerHTML = '<div class="status err">A batch must have at least one item.</div>';
      return;
    }

    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Saving...</div>';

    persistPendingDraft(key)
      .then(function(){
        delete editMode[key];
        renderPendingListFiltered(); // reflects any item routed away to Problem PLUs
        var freshStatusEl = document.getElementById('pendingSaveStatus_' + safeKey);
        if(freshStatusEl){
          freshStatusEl.innerHTML = '<div class="status ok">Changes saved.</div>';
          setTimeout(function(){ freshStatusEl.innerHTML = ''; }, 1500);
        }
      })
      .catch(function(err){
        statusEl.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
      });
  }

  // ---------- Full-screen "please wait" overlay ----------
  // For multi-step writes (resolving a Problem PLU, submitting a batch)
  // that take a few seconds — blocks taps so nothing is double-submitted.
  function showBusy(msg){
    var el = document.getElementById('busyOverlay');
    if(!el){
      el = document.createElement('div');
      el.id = 'busyOverlay';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10000;';
      el.innerHTML = '<div class="card" style="margin:0;text-align:center;max-width:320px;width:100%;">' +
        '<div><span class="spinner"></span></div>' +
        '<div id="busyMsg" style="margin-top:10px;font-weight:600;"></div>' +
        '<div class="pending-meta" style="margin-top:6px;">Please wait, do not close this page.</div></div>';
      document.body.appendChild(el);
    }
    document.getElementById('busyMsg').textContent = msg || 'Working...';
    el.style.display = 'flex';
  }
  function hideBusy(){
    var el = document.getElementById('busyOverlay');
    if(el) el.style.display = 'none';
  }

  // ---------- Duplicate Material Document check ----------
  // Resolves with a description of another batch already using this
  // Material Document number, or null if it is unused.
  function findDuplicateMaterialDocument(doc, ownTxnId){
    return sb.from('bad_stock_fresh_market')
      .select('batch_id, category, staff, entry_date, plant')
      .eq('material_document', doc)
      .neq('batch_id', ownTxnId)
      .limit(1)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        if(!res.data.length) return null;
        var r = res.data[0];
        return (r.category || '-') + ', ' + (r.staff || '-') + ', ' + formatDateDisplay(r.entry_date) + ' (' + r.plant + ')';
      });
  }

  function submitPendingBatch(key){
    if(editMode[key]){ alert('Finish editing first: tap Save Changes, or Cancel.'); return; }
    var draft = pendingDraft[key];
    var batch = fmFindBatch(key);
    var statusId = 'pendingSubmitStatus_' + key.replace(/[^a-zA-Z0-9]/g,'_');
    var statusEl = document.getElementById(statusId);

    var focusField = function(cls){
      var f = document.querySelector('.' + cls + '[data-key="' + key + '"]');
      if(f) f.focus();
    };
    if(!draft.materialDocument || !draft.materialDocument.trim()){
      statusEl.innerHTML = '<div class="status err">Material Document is required.</div>';
      focusField('pending-material-doc');
      return;
    }
    if(!/^\d+$/.test(draft.materialDocument.trim())){
      statusEl.innerHTML = '<div class="status err">Material Document must be numbers only.</div>';
      focusField('pending-material-doc');
      return;
    }
    if(!draft.keyInBy || !draft.keyInBy.trim()){
      statusEl.innerHTML = '<div class="status err">Key In By is required.</div>';
      focusField('pending-key-in-by');
      return;
    }
    if(/^[\d\s]+$/.test(draft.keyInBy.trim())){
      statusEl.innerHTML = '<div class="status err">Key In By should be your name, not a number. Please check you did not swap it with the Material Document.</div>';
      focusField('pending-key-in-by');
      return;
    }

    var doc = draft.materialDocument.trim();
    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Checking...</div>';
    showBusy('Submitting batch...');

    findDuplicateMaterialDocument(doc, batch.txnId)
      .then(function(dupInfo){
        if(dupInfo){
          hideBusy();
          var proceed = confirm(
            'Material Document ' + doc + ' is already used by another transaction:\n\n' +
            dupInfo + '\n\nThis may be a typo. Submit anyway?'
          );
          if(!proceed){
            statusEl.innerHTML = '<div class="status err">Cancelled. Please check the Material Document number.</div>';
            focusField('pending-material-doc');
            return null;
          }
          showBusy('Submitting batch...');
        }
        statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Submitting...</div>';
        return submitITEntryToSupabase(batch.txnId, draft.items, fmBatchInfo(batch), doc, draft.keyInBy.trim())
          .then(function(res){
            draft.submitted = res.printData;
            statusEl.innerHTML = '';
            hideBusy();
            renderPendingListFiltered();
          });
      })
      .catch(function(err){
        hideBusy();
        statusEl.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
      });
  }

  // ---------- Cross-batch print gate: unresolved siblings ----------
  // A single New Entry submission can split into several batches (one per
  // category, plus a separate "unresolved" one for unmatched PLUs) that
  // all share the same submission_id. A category batch on its own can be
  // fully matched and otherwise printable, but if the SAME original
  // submission still has a sibling item stuck unresolved elsewhere, this
  // blocks printing the whole submission until every item — including the
  // unresolved one(s) — has been resolved via Problem PLUs.
  function submissionHasUnresolvedSiblings(items){
    var submissionIds = [];
    (items || []).forEach(function(it){
      if(it.submissionId && submissionIds.indexOf(it.submissionId) === -1) submissionIds.push(it.submissionId);
    });
    // Rows created before this feature existed have no submission_id —
    // nothing to trace, so don't block those.
    if(!submissionIds.length) return Promise.resolve(false);

    return sb.from('bad_stock_fresh_market')
      .select('id')
      .eq('status', 'unresolved')
      .in('submission_id', submissionIds)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return res.data.length > 0;
      });
  }

  function printBatch(key){
    var draft = pendingDraft[key];
    if(!draft) return;

    // Refuse to print while any item in this batch is still flagged "not
    // in Masterlist" (blank description — same flag New Entry's "Proceed
    // anyway" produces). Applies whether the batch has already been
    // submitted (checks the stored printData) or is still pending (checks
    // the live draft items).
    var itemsToCheck = draft.submitted ? draft.submitted.items : draft.items;
    var hasUnmatched = itemsToCheck.some(function(it){ return !it.description; });
    if(hasUnmatched){
      alert('Some data is not in the masterlist. Please check.');
      return;
    }

    submissionHasUnresolvedSiblings(itemsToCheck)
      .then(function(blocked){
        if(blocked){
          alert('This submission still has a Problem PLU pending in another category. Resolve it under IT Entry \u2192 Problem PLUs before printing.');
          return;
        }

        if(draft.submitted){
          openPrintView(draft.submitted);
          return;
        }

        // Not submitted yet — print with whatever's currently in this
        // card, leaving Material Document / Key In By blank for
        // hand-writing.
        var batch = fmFindBatch(key) ||
                    adminPendingEntries.find(function(b){ return pendingKey(b) === key; }) ||
                    completedEntries.find(function(b){ return pendingKey(b) === key; });
        if(!batch) return;
        openPrintView({
          date: batch.dateDisplay,
          time: '',
          category: batch.category,
          staff: batch.staff,
          supervisor: batch.supervisor,
          checkedBy: batch.checkedBy || '',
          refNo: batch.refNo || '',
          materialDocument: draft.materialDocument || '',
          keyInBy: draft.keyInBy || '',
          items: draft.items
        });
      })
      .catch(function(err){
        alert('Could not verify this submission is fully resolved: ' + err.message);
      });
  }

  // A value on the printout, or an empty ruled line to write on when it isn't filled in yet.
  function printVal(v){
    return (v && String(v).trim()) ? '<b>' + escapeHtml(v) + '</b>' : '<b class="blank"></b>';
  }

  function openPrintView(p){
    // Includes a UOM column, right of Quantity, on the printed slip.
    var itemsRows = p.items.map(function(it, idx){
      return '<tr><td class="no">' + (idx + 1) + '</td><td>' + escapeHtml(it.plu) + '</td><td>' + escapeHtml(it.description || '') + '</td><td>' + escapeHtml(String(it.qty)) + '</td><td>' + escapeHtml(it.uom || '') + '</td></tr>';
    }).join('');

    // Reflects whichever outlet is currently active on this device, so a
    // report printed at 1015-SHPL correctly reads "SHPL", not "SHBN".
    var outletName = outletShortName(currentOutletPlant);

    // New-format reports (entered with a Checked By name) sign as Supervisor Fresh Market /
    // Checked By / Verified By (blank). Older records keep the Staff / Supervisor layout.
    var newFmt = !!(p.checkedBy && String(p.checkedBy).trim());
    var signBoxes = newFmt
      ? '<div class="sign-box"><div class="sign-line"></div><div class="sign-label">Supervisor Fresh Market</div>' + escapeHtml(p.supervisor) + '</div>' +
        '<div class="sign-box"><div class="sign-line"></div><div class="sign-label">Checked By</div>' + escapeHtml(p.checkedBy) + '</div>' +
        '<div class="sign-box"><div class="sign-line"></div><div class="sign-label">Verified By</div>&nbsp;</div>'
      : '<div class="sign-box"><div class="sign-line"></div><div class="sign-label">Staff</div>' + escapeHtml(p.staff) + '</div>' +
        '<div class="sign-box"><div class="sign-line"></div><div class="sign-label">Supervisor</div>' + escapeHtml(p.supervisor) + '</div>';

    var html =
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + escapeHtml(outletName) + ' Fresh Market Disposal</title><style>' +
      'body{font-family:Georgia, "Times New Roman", serif;color:#222;margin:32px;}' +
      '.title{text-align:center;font-size:20px;font-weight:700;letter-spacing:0.5px;margin-bottom:2px;}' +
      '.subtitle{text-align:center;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;}' +
      '.meta{display:grid;grid-template-columns:1fr 1fr;gap:0 24px;font-size:13px;margin-bottom:14px;border-top:1px solid #999;border-bottom:1px solid #999;padding:10px 0;}' +
      '.meta .col > div{margin-bottom:8px;}.meta .col > div:last-child{margin-bottom:0;}' +
      '.meta div span{color:#666;}' +
      '.meta div b{display:block;font-size:14px;}.meta div b.blank{height:20px;width:170px;border-bottom:1px solid #333;margin-top:2px;}' +
      'table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:30px;}' +
      'thead{display:table-header-group;}' + /* explicit: repeat this on every printed page */
      'tr{page-break-inside:avoid;}' +
      '.doc-head-cell{border:none;padding:0 0 14px 0;text-align:left;}' +
      'th,td{border:1px solid #999;padding:8px 10px;text-align:left;}' +
      'th.no,td.no{width:34px;text-align:center;padding-left:4px;padding-right:4px;}' +
      'th.col-head{background:#eee;text-transform:uppercase;font-size:11px;letter-spacing:0.3px;}' +
      '.sign-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin-top:50px;page-break-inside:avoid;}' +
      '.sign-box{font-size:12px;}' +
      '.sign-line{border-top:1px solid #333;margin-top:40px;padding-top:6px;}' +
      '.sign-label{font-weight:700;text-transform:uppercase;font-size:10.5px;letter-spacing:0.4px;color:#444;}' +
      '@media print{ body{margin:12mm;} }' +
      '</style></head><body>' +
      '<table>' +
        '<thead>' +
          '<tr><th colspan="5" class="doc-head-cell">' +
            '<div class="title">' + escapeHtml(outletName) + ' &mdash; Fresh Market Disposal</div>' +
            '<div class="subtitle">Bad Stock Report</div>' +
            '<div class="meta">' +
              '<div class="col">' +
                (p.refNo ? '<div><span>Reference Number</span><b>' + escapeHtml(p.refNo) + '</b></div>' : '') +
                '<div><span>Date</span><b>' + escapeHtml(p.date) + (p.time ? ', ' + escapeHtml(p.time) : '') + '</b></div>' +
                '<div><span>Bad Stock Category</span><b>' + escapeHtml(p.category) + '</b></div>' +
                '<div><span>Material Document</span>' + printVal(p.materialDocument) + '</div>' +
              '</div>' +
              '<div class="col">' +
                '<div><span>Staff</span><b>' + escapeHtml(p.staff) + '</b></div>' +
                '<div><span>' + (newFmt ? 'Supervisor Fresh Market' : 'Supervisor') + '</span><b>' + escapeHtml(p.supervisor) + '</b></div>' +
                (newFmt ? '<div><span>Checked By</span><b>' + escapeHtml(p.checkedBy) + '</b></div>' : '') +
                '<div><span>Key In By</span>' + printVal(p.keyInBy) + '</div>' +
              '</div>' +
            '</div>' +
          '</th></tr>' +
          '<tr><th class="col-head no">No.</th><th class="col-head">PLU / Product Code</th><th class="col-head">Description</th><th class="col-head">Quantity</th><th class="col-head">UOM</th></tr>' +
        '</thead>' +
        '<tbody>' + itemsRows + '</tbody>' +
      '</table>' +
      '<div class="sign-grid">' + signBoxes + '</div>' +
      '</body></html>';

    // Print from a hidden iframe so the browser's print dialog opens right
    // here in the current tab — no extra tab to open and close afterwards.
    var old = document.getElementById('printFrame');
    if(old) old.parentNode.removeChild(old);
    var frame = document.createElement('iframe');
    frame.id = 'printFrame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);
    var fdoc = frame.contentWindow.document;
    fdoc.open();
    fdoc.write(html);
    fdoc.close();
    setTimeout(function(){
      try{
        frame.contentWindow.focus();
        frame.contentWindow.print();
      }catch(e){
        alert('Could not open the print dialog: ' + e.message);
      }
    }, 300);
  }

  // ================= ADMIN =================

  // Checked client-side rather than via Apps Script — this was the last
  // thing still depending on that legacy backend, and this gate is a
  // simple deterrent, not real security, either way.
  var ADMIN_PASSWORD = '8888';
  var OUTLET_PASSWORDS = { '1008': '1144SHBN', '1015': '2255SHPL', '1007': '3366SHPP' };

  function unlockAdmin(){
    var pw = document.getElementById('adminPasswordInput').value;
    var statusEl = document.getElementById('adminLockStatus');

    if(pw === ADMIN_PASSWORD){
      adminUnlocked = true;
      document.getElementById('adminLockView').style.display = 'none';
      document.getElementById('adminUnlockedView').style.display = 'block';
      populateAdminOutletDropdown();
      populateAdminCategoryDropdown();
      loadAdminPendingList();
      gdAdminInit();
    } else {
      statusEl.innerHTML = '<div class="status err">Incorrect password.</div>';
    }
  }

  function populateAdminOutletDropdown(){
    var select = document.getElementById('adminOutletSelect');
    select.innerHTML = '';
    OUTLET_OPTIONS.forEach(function(o){
      var opt = document.createElement('option');
      opt.value = o.plant; opt.textContent = o.label;
      select.appendChild(opt);
    });
    select.value = currentOutletPlant;
  }

  function saveOutletSetting(){
    var selected = document.getElementById('adminOutletSelect').value;
    var statusEl = document.getElementById('outletSettingStatus');

    if(selected === currentOutletPlant){
      statusEl.innerHTML = '<div class="status ok">Already set to ' + escapeHtml(outletLabel(selected)) + '.</div>';
      return;
    }

    var pwEl = document.getElementById('outletPasswordInput');
    if(!pwEl.value || pwEl.value.trim() !== OUTLET_PASSWORDS[selected]){
      statusEl.innerHTML = '<div class="status err">' + (pwEl.value ? 'Wrong password for ' : 'Enter the password for ') + escapeHtml(outletLabel(selected)) + '.</div>';
      pwEl.value = '';
      pwEl.focus();
      return;
    }
    statusEl.innerHTML = '';

    if(gdCart.length){
      statusEl.innerHTML = '<div class="status err">Goods New Entry still has ' + gdCart.length + ' unsent item(s) for ' + escapeHtml(outletLabel(currentOutletPlant)) +
        '. Submit or clear that list first, otherwise it would be sent to the wrong outlet.</div>';
      document.getElementById('adminOutletSelect').value = currentOutletPlant;
      return;
    }
    if(cart.length){
      statusEl.innerHTML = '<div class="status err">New Entry still has ' + cart.length + ' unsent item(s) for ' + escapeHtml(outletLabel(currentOutletPlant)) +
        '. Submit or clear that list first, otherwise it would be sent to the wrong outlet.</div>';
      document.getElementById('adminOutletSelect').value = currentOutletPlant;
      return;
    }
    if(outboxLoad().length){
      statusEl.innerHTML = '<div class="status err">There are submissions still queued to send. Wait until they are sent, then change the outlet.</div>';
      document.getElementById('adminOutletSelect').value = currentOutletPlant;
      return;
    }

    showConfirmModal({
      title: 'Change outlet?',
      bodyHtml:
        '<div style="font-size:15px;margin:6px 0 12px;"><b>' + escapeHtml(outletLabel(currentOutletPlant)) + '</b> &rarr; <b>' + escapeHtml(outletLabel(selected)) + '</b></div>' +
        '<div class="pending-meta">This device will show and save data for the new outlet in New Entry, IT Entry, Completed and Problem PLUs. ' +
        'Anything submitted afterwards is recorded under <b>' + escapeHtml(outletLabel(selected)) + '</b>. The Masterlist stays shared.</div>',
      confirmLabel: 'Yes, switch outlet',
      onConfirm: function(){ document.getElementById('outletPasswordInput').value = ''; applyOutletChange(selected); },
      onCancel: function(){ document.getElementById('adminOutletSelect').value = currentOutletPlant; }
    });
  }

  function applyOutletChange(selected){
    var statusEl = document.getElementById('outletSettingStatus');
    try {
      localStorage.setItem(OUTLET_STORAGE_KEY, selected);
    } catch (e) { /* storage unavailable — still applies for this page load */ }

    currentOutletPlant = selected;
    applyOutletBranding();
    statusEl.innerHTML = '<div class="status ok">Outlet set to ' + escapeHtml(outletLabel(selected)) + '.</div>';

    // Clear cached pending/completed data so the next visit to IT Entry
    // re-fetches under the new outlet, rather than showing stale rows
    // from whichever outlet was active before.
    pendingEntries = [];
    completedEntries = [];
    pendingDraft = {};
    selectedPendingCategory = null;
    selectedCompletedCategory = null;
    lastPendingSig = null; lastProblemSig = null; lastCompletedSig = null;
    gdPending = []; gdCompleted = []; gdDraft = {}; gdSelPendingCat = null; gdSelCompletedCat = null;
    gdLastPendingSig = null; gdLastCompletedSig = null;
    gdLoadPending({silent:true, force:true}).catch(function(){}).then(refreshHomeDashboard);
    gdLoadAdminPending();

    loadProblemPlus();
    loadAdminPendingList();
  }

  // Generic confirmation popup (styled, replaces the browser confirm()).
  function showConfirmModal(o){
    var old = document.getElementById('confirmModalOverlay');
    if(old) old.parentNode.removeChild(old);
    var overlay = document.createElement('div');
    overlay.id = 'confirmModalOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999;';
    overlay.innerHTML =
      '<div class="card" style="max-width:420px;width:100%;margin:0;">' +
        '<h2 style="margin-top:0;">&#9888; ' + escapeHtml(o.title) + '</h2>' + o.bodyHtml +
        '<button class="btn btn-full" id="confirmModalYes">' + escapeHtml(o.confirmLabel || 'Confirm') + '</button>' +
        '<button class="btn ghost btn-full" id="confirmModalNo">Cancel</button>' +
      '</div>';
    document.body.appendChild(overlay);
    var close = function(){ overlay.parentNode.removeChild(overlay); };
    document.getElementById('confirmModalYes').addEventListener('click', function(){ close(); if(o.onConfirm) o.onConfirm(); });
    document.getElementById('confirmModalNo').addEventListener('click', function(){ close(); if(o.onCancel) o.onCancel(); });
  }

  // ---------- Admin: Add New Category ----------
  // Categories live in Supabase, shared with the Masterlist — adding one
  // here is visible to both outlet deployments immediately, not just this
  // device. Purely additive (no delete/rename here), so no confirmation
  // step is needed, just a duplicate check.
  function submitNewCategory(){
    var name = document.getElementById('newCategoryInput').value.trim();
    var statusEl = document.getElementById('newCategoryStatus');

    if(!name){
      statusEl.innerHTML = '<div class="status err">Enter a category name.</div>';
      return;
    }
    var exists = appCategories.some(function(c){ return c.toLowerCase() === name.toLowerCase(); });
    if(exists){
      statusEl.innerHTML = '<div class="status err">This category already exists.</div>';
      return;
    }

    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Saving...</div>';

    sb.from('categories').insert([{ name: name }])
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return getCategoriesFromSupabase();
      })
      .then(function(categories){
        appCategories = categories;
        updateCategorySubtitle();
        populateAdminCategoryDropdown(); // so it's usable immediately in the form just below
        document.getElementById('newCategoryInput').value = '';
        statusEl.innerHTML = '<div class="status ok">Category added.</div>';
      })
      .catch(function(err){
        statusEl.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
      });
  }

  function populateAdminCategoryDropdown(){
    var select = document.getElementById('adminCategory');
    // Rebuild rather than append, in case Admin is unlocked more than once
    // in the same session (appCategories doesn't change mid-session, but
    // this keeps it safe either way).
    select.innerHTML = '<option value="">Select category...</option>';
    appCategories.forEach(function(cat){
      var opt = document.createElement('option');
      opt.value = cat; opt.textContent = cat;
      select.appendChild(opt);
    });
  }

  var FM_DUP_FIELDS = [['PLU', 'plu_code'], ['Description', 'description'], ['Material Code', 'material'], ['UOM', 'uom'], ['Category', 'category']];
  var fmDupPending = null;

  function submitMasterlistItem(){
    var btn = document.getElementById('adminSaveBtn');
    if(btn.disabled) return; // already saving, or waiting on the overwrite confirmation
    var plu = document.getElementById('adminPlu').value.trim();
    var description = document.getElementById('adminDescription').value.trim();
    var material = document.getElementById('adminMaterial').value.trim();
    var uom = document.getElementById('adminUom').value.trim();
    var category = document.getElementById('adminCategory').value;
    var statusEl = document.getElementById('adminSaveStatus');
    var panel = document.getElementById('adminDupPanel');

    var missing = missingFieldNames([['PLU', plu], ['Description', description], ['Material Code', material], ['UOM', uom], ['Category', category]]);
    if(missing.length){
      statusEl.innerHTML = '<div class="status err">Please fill in every field. Missing: ' + missing.join(', ') + '.</div>';
      return;
    }

    panel.innerHTML = '';
    fmDupPending = null;
    setSaveState('adminSaveBtn', 'busy');
    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Checking...</div>';

    var vals = { plu_code: plu, description: description, material: material, uom: uom, category: category };
    sb.from('masterlist').select('plu_code, description, material, uom, category').eq('plu_code', plu).limit(1)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        var ex = res.data && res.data[0];
        if(!ex) return saveMasterlistItemNow(vals);
        if(dupSame(ex, vals, ['description', 'material', 'uom', 'category'])){
          statusEl.innerHTML = '<div class="status ok">PLU ' + escapeHtml(plu) + ' is already in the Masterlist with the same details. Nothing was saved.</div>';
          setSaveState('adminSaveBtn', 'idle');
          return;
        }
        // Exists with different details: do not save until the person confirms.
        fmDupPending = vals;
        statusEl.innerHTML = '';
        panel.innerHTML =
          '<div style="border:1px solid var(--danger);border-radius:12px;padding:12px;margin-top:12px;">' +
            '<b>PLU ' + escapeHtml(plu) + ' already exists in the Masterlist.</b>' +
            '<div class="pending-meta" style="margin-top:4px;">Nothing has been saved. Overwriting replaces the existing item\'s details with yours.</div>' +
            dupCompareHtml(FM_DUP_FIELDS, ex, vals) +
            '<button class="btn danger btn-full" id="adminDupConfirm" onclick="confirmFmOverwrite()">Overwrite existing item</button>' +
            '<button class="btn ghost btn-full" onclick="cancelFmOverwrite()">Cancel (add nothing)</button>' +
          '</div>';
        setSaveState('adminSaveBtn', 'locked');
      })
      .catch(function(err){
        statusEl.innerHTML = '<div class="status err">Error: ' + escapeHtml(err.message) + '</div>';
        setSaveState('adminSaveBtn', 'idle');
      });
  }

  function confirmFmOverwrite(){
    var c = document.getElementById('adminDupConfirm');
    if(!fmDupPending || (c && c.disabled)) return;
    if(c) c.disabled = true;
    var vals = fmDupPending;
    setSaveState('adminSaveBtn', 'busy');
    saveMasterlistItemNow(vals).catch(function(){});
  }

  function cancelFmOverwrite(){
    fmDupPending = null;
    document.getElementById('adminDupPanel').innerHTML = '';
    document.getElementById('adminSaveStatus').innerHTML = '<div class="status ok">Cancelled. Nothing was saved.</div>';
    setSaveState('adminSaveBtn', 'idle');
  }

  function saveMasterlistItemNow(vals){
    var statusEl = document.getElementById('adminSaveStatus');
    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Saving...</div>';
    return addMasterlistItemToSupabase(vals.plu_code, vals.description, vals.material, vals.uom, vals.category)
      .then(function(res){
        fmDupPending = null;
        document.getElementById('adminDupPanel').innerHTML = '';
        statusEl.innerHTML = '<div class="status ok">' + (res.updated ? 'Updated existing PLU in Masterlist.' : 'Added new item to Masterlist.') + '</div>';
        loadRecentMasterActivity();
        document.getElementById('adminPlu').value = '';
        document.getElementById('adminDescription').value = '';
        document.getElementById('adminMaterial').value = '';
        document.getElementById('adminUom').value = '';
        document.getElementById('adminCategory').value = '';
        setSaveState('adminSaveBtn', 'idle');

        // refresh local masterlist cache so New Entry / IT Entry lookups see it immediately
        getMasterlistFromSupabase().then(function(list){
          masterlist = list;
          masterlistByPlu = {};
          list.forEach(function(item){ masterlistByPlu[String(item.plu).trim()] = item; });
        });
      })
      .catch(function(err){
        statusEl.innerHTML = '<div class="status err">Error: ' + escapeHtml(err.message) + '</div>';
        setSaveState('adminSaveBtn', fmDupPending ? 'locked' : 'idle');
        var c = document.getElementById('adminDupConfirm'); if(c) c.disabled = false;
        throw err;
      });
  }

  // ---------- IT Entry: Problem PLUs ----------
  // Distinct list of unresolved PLU codes (deduplicated across every batch/
  // transaction that hit them) — fixing one here resolves every occurrence
  // at once via resolveProblemPlu().
  var problemPlus = [];
  var problemPluEditing = null; // plu code currently expanded for editing

  var lastProblemSig = null;

  function loadProblemPlus(opts){
    opts = opts || {};
    var silent = !!opts.silent;
    if(!silent){
      document.getElementById('problemPluList').innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
      document.getElementById('problemPluEmpty').style.display = 'none';
    }

    return sb.from('bad_stock_fresh_market').select('plu_code, quantity, description, staff, supervisor, entry_date').eq('status', 'unresolved').eq('plant', currentOutletPlant)
      .order('entry_date', { ascending: true })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        var sig = JSON.stringify(res.data);
        if(silent && !opts.force && sig === lastProblemSig) return;
        // Don't redraw underneath someone who has an edit form open.
        if(silent && problemPluEditing !== null) return;
        lastProblemSig = sig;
        var grouped = {};
        res.data.forEach(function(row){
          var key = String(row.plu_code).trim();
          if(!grouped[key]) grouped[key] = { plu: key, count: 0, totalQty: 0, description: '', entries: [] };
          grouped[key].count++;
          grouped[key].entries.push({ staff: row.staff, supervisor: row.supervisor, dateDisplay: formatDateDisplay(row.entry_date), qty: row.quantity });
          grouped[key].totalQty += row.quantity;
          // Carry through whatever description staff typed at New Entry
          // (if any) so Problem PLUs never starts from a blank field —
          // first non-empty one found wins.
          if(!grouped[key].description && row.description) grouped[key].description = row.description;
        });
        problemPlus = Object.keys(grouped).map(function(k){
          var p = grouped[k];
          p.totalQty = Math.round(p.totalQty * 100) / 100;
          return p;
        });
        document.getElementById('problemPluCount').textContent = problemPlus.length;
        renderProblemPlus();
        refreshHomeDashboard();
      })
      .catch(function(err){
        if(silent) throw err;
        document.getElementById('problemPluList').innerHTML =
          '<div class="status err">Failed to load problem PLUs: ' + err.message + '</div>';
      });
  }

  function renderProblemPlus(){
    var container = document.getElementById('problemPluList');
    var emptyEl = document.getElementById('problemPluEmpty');
    container.innerHTML = '';

    if(!problemPlus.length){
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    problemPlus.forEach(function(p){
      var safePlu = p.plu.replace(/[^a-zA-Z0-9]/g,'_');
      var isEditing = problemPluEditing === p.plu;
      var card = document.createElement('div');
      card.className = 'card';

      var html =
        '<div class="pending-card-header">' +
          '<div><b>PLU ' + escapeHtml(p.plu) + '</b></div>' +
          '<span class="edit-link" onclick="toggleProblemPluEdit(\'' + p.plu + '\')">' + (isEditing ? 'Cancel' : '\u270E Edit') + '</span>' +
        '</div>' +
        '<div class="pending-meta">' + p.count + ' entr' + (p.count === 1 ? 'y' : 'ies') + ' &middot; ' + p.totalQty + ' total qty</div>' +
        p.entries.map(function(e){
          return '<div class="pending-meta"><b>' + escapeHtml(e.staff || '-') + '</b> &middot; Sup: ' + escapeHtml(e.supervisor || '-') + ' &middot; ' + escapeHtml(e.dateDisplay || '') + ' &middot; qty ' + e.qty + '</div>';
        }).join('');

      if(isEditing){
        var catOptions = appCategories.map(function(c){
          return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
        }).join('');
        html +=
          '<label>PLU Code</label>' +
          '<input type="text" id="ppPlu_' + safePlu + '" value="' + escapeHtml(p.plu) + '">' +
          '<label>Description</label>' +
          '<input type="text" id="ppDesc_' + safePlu + '" value="' + escapeHtml(p.description || '') + '" placeholder="e.g. FRESH WHOLE CHICKEN">' +
          '<label>Material Code</label>' +
          '<input type="text" id="ppMaterial_' + safePlu + '" placeholder="e.g. 10089824">' +
          '<label>UOM</label>' +
          '<input type="text" id="ppUom_' + safePlu + '" placeholder="e.g. KG">' +
          '<label>Category</label>' +
          '<select id="ppCategory_' + safePlu + '"><option value="">Select category...</option>' + catOptions + '</select>' +
          '<button class="btn btn-full" id="ppSaveBtn_' + safePlu + '" onclick="saveProblemPlu(\'' + p.plu + '\')">Save to Masterlist</button>' +
          '<button class="btn danger btn-full" onclick="deleteProblemPlu(\'' + p.plu + '\')">Delete</button>' +
          '<div id="ppStatus_' + safePlu + '">' + (ppDup[p.plu] ? ppDupHtml(p.plu) : '') + '</div>';
      }

      card.innerHTML = html;
      container.appendChild(card);
    });
  }

  function toggleProblemPluEdit(plu){
    problemPluEditing = (problemPluEditing === plu) ? null : plu;
    renderProblemPlus();
  }

  var ppDup = {}; // original PLU -> { vals, existing } while the "already exists" choice is open

  function ppDupHtml(originalPlu){
    var d = ppDup[originalPlu];
    if(!d) return '';
    var q = "'" + originalPlu + "'";
    return '<div style="border:1px solid var(--danger);border-radius:12px;padding:12px;margin-top:12px;">' +
      '<b>PLU ' + escapeHtml(d.vals.plu_code) + ' already exists in the Masterlist.</b>' +
      '<div class="pending-meta" style="margin-top:4px;">Nothing has been changed yet. Choose what to do with the entries:</div>' +
      dupCompareHtml(FM_DUP_FIELDS, d.existing, d.vals) +
      '<button class="btn btn-full" onclick="ppUseExisting(' + q + ')">Use the existing item (no change to Masterlist)</button>' +
      '<button class="btn danger btn-full" onclick="ppOverwriteExisting(' + q + ')">Overwrite existing item with my details</button>' +
      '<button class="btn ghost btn-full" onclick="ppCancelDup(' + q + ')">Cancel</button>' +
    '</div>';
  }

  function saveProblemPlu(originalPlu){
    var safePlu = originalPlu.replace(/[^a-zA-Z0-9]/g,'_');
    var newPlu = document.getElementById('ppPlu_' + safePlu).value.trim();
    var description = document.getElementById('ppDesc_' + safePlu).value.trim();
    var material = document.getElementById('ppMaterial_' + safePlu).value.trim();
    var uom = document.getElementById('ppUom_' + safePlu).value.trim();
    var category = document.getElementById('ppCategory_' + safePlu).value;
    var statusEl = document.getElementById('ppStatus_' + safePlu);
    var btn = document.getElementById('ppSaveBtn_' + safePlu);

    if(btn && btn.disabled) return;

    var missing = missingFieldNames([['PLU Code', newPlu], ['Description', description], ['Material Code', material], ['UOM', uom], ['Category', category]]);
    if(missing.length){
      statusEl.innerHTML = '<div class="status err">Please fill in every field. Missing: ' + missing.join(', ') + '.</div>';
      return;
    }

    delete ppDup[originalPlu];
    var vals = { plu_code: newPlu, description: description, material: material, uom: uom, category: category };
    if(btn) btn.disabled = true;
    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Checking...</div>';

    // Check the Masterlist BEFORE touching anything, so a corrected PLU that
    // already exists is never silently overwritten.
    sb.from('masterlist').select('plu_code, description, material, uom, category').eq('plu_code', newPlu).limit(1)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        var ex = res.data && res.data[0];
        if(ex && !dupSame(ex, vals, ['description', 'material', 'uom', 'category'])){
          ppDup[originalPlu] = { vals: vals, existing: ex };
          statusEl.innerHTML = ppDupHtml(originalPlu);
          if(btn) btn.disabled = false;
          return;
        }
        return runProblemSave(originalPlu, vals);
      })
      .catch(function(err){
        if(btn) btn.disabled = false;
        statusEl.innerHTML = '<div class="status err">Error: ' + escapeHtml(err.message) + '</div>';
      });
  }

  function ppUseExisting(originalPlu){
    var d = ppDup[originalPlu]; if(!d) return;
    var ex = d.existing;
    runProblemSave(originalPlu, { plu_code: ex.plu_code, description: ex.description, material: ex.material, uom: ex.uom, category: ex.category });
  }
  function ppOverwriteExisting(originalPlu){
    var d = ppDup[originalPlu]; if(!d) return;
    runProblemSave(originalPlu, d.vals);
  }
  function ppCancelDup(originalPlu){
    delete ppDup[originalPlu];
    var statusEl = document.getElementById('ppStatus_' + originalPlu.replace(/[^a-zA-Z0-9]/g,'_'));
    if(statusEl) statusEl.innerHTML = '<div class="status ok">Cancelled. Nothing was changed.</div>';
  }

  // Applies the save: rename (if the PLU code was corrected), write the
  // Masterlist item, then resolve every unresolved entry for this PLU.
  function runProblemSave(originalPlu, vals){
    var safePlu = originalPlu.replace(/[^a-zA-Z0-9]/g,'_');
    var statusEl = document.getElementById('ppStatus_' + safePlu);
    var btn = document.getElementById('ppSaveBtn_' + safePlu);
    var newPlu = vals.plu_code;
    if(btn) btn.disabled = true;
    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Saving...</div>';
    showBusy('Saving PLU and moving entries to ' + vals.category + '...');

    // If the PLU code itself was corrected (e.g. a scan typo), rename it
    // across every unresolved row using the old code first — matches how
    // resolving already applies everywhere, since Masterlist is shared.
    var renameStep = (newPlu !== originalPlu)
      ? sb.from('bad_stock_fresh_market').update({ plu_code: newPlu }).eq('plu_code', originalPlu).eq('status', 'unresolved')
          .then(function(res){ if(res.error) throw new Error(res.error.message); })
      : Promise.resolve();

    return renameStep
      .then(function(){
        return resolveProblemPlu(newPlu, vals.description, vals.material, vals.uom, vals.category);
      })
      .then(function(){
        return getMasterlistFromSupabase();
      })
      .then(function(list){
        masterlist = list;
        masterlistByPlu = {};
        list.forEach(function(item){ masterlistByPlu[String(item.plu).trim()] = item; });
        delete ppDup[originalPlu];
        problemPluEditing = null;
        hideBusy();
        loadProblemPlus(); // resolved PLU should now disappear from the list
      })
      .catch(function(err){
        hideBusy();
        if(btn) btn.disabled = false;
        statusEl.innerHTML = '<div class="status err">Error: ' + escapeHtml(err.message) + '</div>';
      });
  }

  // Deletes this outlet's unresolved rows for a Problem PLU outright —
  // for entries that shouldn't have been logged at all, rather than ones
  // that need a masterlist fix. Scoped to the CURRENT outlet only (unlike
  // resolving, which intentionally applies everywhere since the masterlist
  // is shared) — deletion is destructive, so it only removes what's
  // actually shown on screen, never another outlet's data.
  function deleteProblemPlu(plu){
    var safePlu = plu.replace(/[^a-zA-Z0-9]/g,'_');
    var statusEl = document.getElementById('ppStatus_' + safePlu);
    var p = problemPlus.find(function(x){ return x.plu === plu; });

    var ok = confirm(
      'Delete PLU ' + plu + '?\n\n' +
      (p ? p.count + ' unresolved entr' + (p.count === 1 ? 'y' : 'ies') + ', ' + p.totalQty + ' total qty' : 'These entries') +
      ' for this outlet will be permanently removed. This cannot be undone.'
    );
    if(!ok) return;

    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Deleting...</div>';
    showBusy('Deleting PLU ' + plu + '...');

    sb.from('bad_stock_fresh_market').delete().eq('plu_code', plu).eq('status', 'unresolved').eq('plant', currentOutletPlant)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        problemPluEditing = null;
        hideBusy();
        loadProblemPlus();
      })
      .catch(function(err){
        hideBusy();
        statusEl.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
      });
  }

  // ---------- Admin: Edit Existing Masterlist Item ----------
  // Search a PLU already in the masterlist, edit any field, and require
  // typing CONFIRM before the update commits — unlike Problem PLUs (filling
  // in blanks for the first time) or the manual Add/Update form, this can
  // silently change how an already-in-use, possibly-historical PLU reads
  // everywhere in the app, so it gets an extra guard rail.
  var masterlistSearchResult = null;
  var masterlistEditMode = false;
  var masterlistConfirmMode = false;
  // Captured right before switching into confirm mode, since re-rendering
  // for that step was previously regenerating the input fields straight
  // from the ORIGINAL loaded record — silently discarding whatever the
  // admin had just typed, so Save Changes would re-save the unedited data.
  var masterlistEditValues = null;

  function searchMasterlistItem(){
    var plu = document.getElementById('masterlistSearchInput').value.trim();
    var statusEl = document.getElementById('masterlistSearchStatus');
    var resultEl = document.getElementById('masterlistSearchResult');

    if(!plu){
      statusEl.innerHTML = '<div class="status err">Enter a PLU code to search.</div>';
      resultEl.innerHTML = '';
      masterlistSearchResult = null;
      return;
    }

    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Searching...</div>';
    resultEl.innerHTML = '';
    masterlistEditMode = false;
    masterlistConfirmMode = false;

    sb.from('masterlist').select('*').eq('plu_code', plu)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        if(!res.data.length){
          statusEl.innerHTML = '<div class="status err">No masterlist item found for PLU "' + escapeHtml(plu) + '".</div>';
          masterlistSearchResult = null;
          return;
        }
        statusEl.innerHTML = '';
        masterlistSearchResult = res.data[0];
        renderMasterlistSearchResult();
      })
      .catch(function(err){
        statusEl.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
      });
  }

  function renderMasterlistSearchResult(){
    var resultEl = document.getElementById('masterlistSearchResult');
    resultEl.innerHTML = '';
    if(!masterlistSearchResult) return;

    var r = masterlistSearchResult;
    // Use whatever the admin has typed so far (captured right before
    // showing the confirm step) rather than the original loaded record,
    // so re-rendering into confirm mode never discards in-progress edits.
    var vals = masterlistEditValues || { plu_code: r.plu_code, description: r.description, material: r.material, uom: r.uom, category: r.category };
    var card = document.createElement('div');
    card.className = 'card';

    var html =
      '<div class="pending-card-header">' +
        '<div><b>PLU ' + escapeHtml(r.plu_code) + '</b></div>' +
        (!masterlistEditMode ? '<span class="edit-link" onclick="toggleMasterlistEdit()">\u270E Edit</span>' : '') +
      '</div>';

    if(!masterlistEditMode){
      html +=
        '<div class="lookup-preview">' +
        '<div class="row"><span>Description</span><b>' + escapeHtml(r.description) + '</b></div>' +
        '<div class="row"><span>Material</span><b>' + escapeHtml(r.material) + '</b></div>' +
        '<div class="row"><span>UOM</span><b>' + escapeHtml(r.uom) + '</b></div>' +
        '<div class="row"><span>Category</span><b>' + escapeHtml(r.category || '\u2014') + '</b></div>' +
        '</div>';
    } else {
      if(masterlistConfirmMode){
        // Review step: before / after side by side, what changed, then Confirm.
        var fields = [['PLU Code', 'plu_code'], ['Description', 'description'], ['Material Code', 'material'], ['UOM', 'uom'], ['Category', 'category']];
        var norm = function(v){ return String(v == null ? '' : v).trim(); };
        var changed = fields.filter(function(f){ return norm(r[f[1]]) !== norm(vals[f[1]]); });
        html +=
          '<div class="review-banner ' + (changed.length ? 'has-changes' : 'no-changes') + '">' +
            (changed.length
              ? '<b>' + changed.length + ' change' + (changed.length === 1 ? '' : 's') + ' to review:</b> ' + changed.map(function(f){ return escapeHtml(f[0]); }).join(', ') + '.'
              : '<b>No changes made.</b> Nothing differs from the current Masterlist entry.') +
          '</div>' +
          '<table class="review-table"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>' +
          fields.map(function(f){
            var diff = norm(r[f[1]]) !== norm(vals[f[1]]);
            return '<tr' + (diff ? ' class="changed"' : '') + '><td><b>' + escapeHtml(f[0]) + '</b></td>' +
              '<td>' + escapeHtml(norm(r[f[1]]) || '—') + '</td>' +
              '<td>' + (diff ? '<b>' + escapeHtml(norm(vals[f[1]]) || '—') + '</b>' : escapeHtml(norm(vals[f[1]]) || '—')) + '</td></tr>';
          }).join('') + '</tbody></table>' +
          (norm(r.plu_code) !== norm(vals.plu_code)
            ? '<div class="status err" style="margin-top:8px;">The PLU code itself is changing from ' + escapeHtml(r.plu_code) + ' to ' + escapeHtml(vals.plu_code) + '. This updates how it reads everywhere in the app.</div>'
            : '') +
          '<div class="btn-row">' +
            '<button class="btn ghost" onclick="cancelMasterlistConfirm()">Back to edit</button>' +
            '<button class="btn" id="meConfirmBtn" onclick="confirmMasterlistSave()"' + (changed.length ? '' : ' disabled') + '>Confirm &amp; Save</button>' +
          '</div>';
      } else {
        var catOptions = appCategories.map(function(c){
          return '<option value="' + escapeHtml(c) + '"' + (c === vals.category ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
        }).join('');
        html +=
          '<label>PLU Code</label><input type="text" id="mePlu" value="' + escapeHtml(vals.plu_code) + '">' +
          '<label>Description</label><input type="text" id="meDesc" value="' + escapeHtml(vals.description) + '">' +
          '<label>Material Code</label><input type="text" id="meMaterial" value="' + escapeHtml(vals.material) + '">' +
          '<label>UOM</label><input type="text" id="meUom" value="' + escapeHtml(vals.uom) + '">' +
          '<label>Category</label><select id="meCategory"><option value="">Select category...</option>' + catOptions + '</select>' +
          '<button class="btn btn-full" onclick="requestMasterlistSave()">Save Changes</button>' +
          '<button class="btn ghost btn-full" onclick="cancelMasterlistEdit()">Cancel</button>';
      }
      html += '<div id="masterlistEditStatus"></div>';
    }

    card.innerHTML = html;
    resultEl.appendChild(card);
  }

  function toggleMasterlistEdit(){
    masterlistEditMode = true;
    masterlistConfirmMode = false;
    masterlistEditValues = null; // fresh edit session starts from the original loaded record
    renderMasterlistSearchResult();
  }

  function requestMasterlistSave(){
    var newPlu = document.getElementById('mePlu').value.trim();
    var description = document.getElementById('meDesc').value.trim();
    var material = document.getElementById('meMaterial').value.trim();
    var uom = document.getElementById('meUom').value.trim();
    var category = document.getElementById('meCategory').value;
    if(!newPlu || !description || !material || !uom || !category){
      document.getElementById('masterlistEditStatus').innerHTML =
        '<div class="status err">PLU Code, Description, Material Code, UOM and Category are all required.</div>';
      return;
    }
    // Captured now, before switching into confirm mode, so the re-render
    // for that step shows exactly what was just typed.
    masterlistEditValues = { plu_code: newPlu, description: description, material: material, uom: uom, category: category };
    masterlistConfirmMode = true;
    renderMasterlistSearchResult();
  }

  function cancelMasterlistEdit(){
    masterlistEditMode = false;
    masterlistConfirmMode = false;
    masterlistEditValues = null;
    renderMasterlistSearchResult();
  }

  function cancelMasterlistConfirm(){
    masterlistConfirmMode = false;
    renderMasterlistSearchResult();
  }

  function confirmMasterlistSave(){
    var btn = document.getElementById('meConfirmBtn');
    if(btn){ if(btn.disabled) return; btn.disabled = true; btn.textContent = 'Saving...'; }

    var originalPlu = masterlistSearchResult.plu_code;
    var rowId = masterlistSearchResult.id;
    var vals = masterlistEditValues;
    var newPlu = vals.plu_code;

    var statusEl = document.getElementById('masterlistEditStatus');
    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Saving...</div>';

    // Renaming needs a direct id-based update, not the usual upsert-by-
    // plu_code helper — that would look up the NEW code, find nothing,
    // and insert a brand-new row while leaving the old one behind as an
    // orphaned duplicate. A conflict check comes first so a rename can
    // never silently collide with a different existing PLU.
    var conflictCheck = (newPlu !== originalPlu)
      ? sb.from('masterlist').select('id').eq('plu_code', newPlu).neq('id', rowId)
          .then(function(res){
            if(res.error) throw new Error(res.error.message);
            if(res.data && res.data.length){
              throw new Error('PLU ' + newPlu + ' already exists as a different Masterlist entry. Resolve that conflict first.');
            }
          })
      : Promise.resolve();

    conflictCheck
      .then(function(){
        return sb.from('masterlist')
          .update({ plu_code: newPlu, description: vals.description, material: vals.material, uom: vals.uom, category: vals.category })
          .eq('id', rowId);
      })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return getMasterlistFromSupabase();
      })
      .then(function(list){
        masterlist = list;
        masterlistByPlu = {};
        list.forEach(function(item){ masterlistByPlu[String(item.plu).trim()] = item; });

        masterlistSearchResult = { id: rowId, plu_code: newPlu, description: vals.description, material: vals.material, uom: vals.uom, category: vals.category };
        masterlistEditMode = false;
        masterlistConfirmMode = false;
        masterlistEditValues = null;
        renderMasterlistSearchResult();
        document.getElementById('masterlistSearchStatus').innerHTML = '<div class="status ok">Masterlist item updated.</div>';
      })
      .catch(function(err){
        statusEl.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
        var b2 = document.getElementById('meConfirmBtn');
        if(b2){ b2.disabled = false; b2.textContent = 'Confirm & Save'; }
      });
  }

  var adminPendingEntries = [];

  function loadAdminPendingList(){
    document.getElementById('adminPendingList').innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
    document.getElementById('adminPendingEmpty').style.display = 'none';

    return getPendingEntriesFromSupabase()
      .then(function(entries){
        adminPendingEntries = entries;
        renderAdminPendingList();
      })
      .catch(function(err){
        document.getElementById('adminPendingList').innerHTML =
          '<div class="status err">Failed to load pending transactions: ' + err.message + '</div>';
      });
  }

  function renderAdminPendingList(){
    var container = document.getElementById('adminPendingList');
    container.innerHTML = '';

    if(!adminPendingEntries.length){
      document.getElementById('adminPendingEmpty').style.display = 'block';
      return;
    }
    document.getElementById('adminPendingEmpty').style.display = 'none';

    adminPendingEntries.forEach(function(batch){
      var key = batch.txnId;
      var safeKey = key.replace(/[^a-zA-Z0-9]/g,'_');
      var itemsList = batch.items.map(function(it){
        var label = it.description ? it.description : ('PLU ' + it.plu) + (it.description ? '' : ' (not in Masterlist)');
        return escapeHtml(label) + ' &times; ' + escapeHtml(String(it.qty)) + (it.uom ? ' ' + escapeHtml(it.uom) : '');
      }).join(', ');

      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="pending-card-header">' +
          '<div><span class="cat-tag">' + escapeHtml(batch.category) + '</span>' + refTag(batch) + '</div>' +
          '<div class="pending-meta">' + escapeHtml(batch.dateDisplay) + '</div>' +
        '</div>' +
        '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(batch.staff) + '</b> &middot; ' + escapeHtml(batch.supervisor) + (batch.checkedBy ? ' &middot; ' + escapeHtml(batch.checkedBy) : '') + '</div>' +
        '<div class="pending-meta" style="margin-top:8px;">' + itemsList + '</div>' +
        '<button class="btn danger btn-full" onclick="deleteAdminPendingBatch(\'' + key + '\')">Delete Transaction</button>' +
        '<div id="adminDeleteStatus_' + safeKey + '"></div>';
      container.appendChild(card);
    });
  }

  function deleteAdminPendingBatch(key){
    var batch = adminPendingEntries.find(function(b){ return b.txnId === key; });
    if(!batch) return;
    var safeKey = key.replace(/[^a-zA-Z0-9]/g,'_');
    var statusEl = document.getElementById('adminDeleteStatus_' + safeKey);

    var confirmed = confirm(
      'Delete this pending transaction?\n\n' +
      (batch.refNo ? 'Ref ' + batch.refNo + '\n' : '') +
      batch.category + ' \u00b7 ' + batch.dateDisplay + '\n' +
      batch.staff + ' / ' + batch.supervisor + (batch.checkedBy ? ' / ' + batch.checkedBy : '') + '\n\n' +
      (batch.refNo ? 'It will be removed from Pending and kept in Admin > Deleted Disposal Record.'
                   : 'This will permanently remove it from Supabase and cannot be undone.')
    );
    if(!confirmed) return;

    statusEl.innerHTML = '<div class="status ok"><span class="spinner"></span> Deleting...</div>';

    deletePendingBatchFromSupabase(batch.txnId, !!batch.refNo)
      .then(function(){
        adminPendingEntries = adminPendingEntries.filter(function(b){ return b.txnId !== key; });
        renderAdminPendingList();

        // keep the IT Entry tab's cached data in sync too, in case it's already loaded
        pendingEntries = pendingEntries.filter(function(b){ return pendingKey(b) !== key; });
        delete pendingDraft[key];
      })
      .catch(function(err){
        statusEl.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
      });
  }

  // =====================================================================
  // ================= GOODS DISPOSAL (DRS) =============================
  // =====================================================================
  // Tables: goods_masterlist (per barcode), goods_categories,
  // bad_stock_goods (one row per item, grouped by batch_id).
  // Everything here is prefixed gd / Gd so it never collides with the
  // Fresh Market code above, which is untouched.

  var GD_REASONS = [
    { label: 'Damaged',      sap: '2' },
    { label: 'Expired',      sap: '1' },
    { label: 'Buy 1 Free 1', sap: '1' },
    { label: 'Others',       sap: ''  }   // typed manually in SAP
  ];
  function gdSapReason(label){
    var m = GD_REASONS.find(function(r){ return r.label === label; });
    return m ? m.sap : '';
  }
  var GD_MAX_QTY = 999;
  var GD_DRAFT_KEY = 'drs_goods_draft_v1';
  var GD_SAP_CHUNK = 7;

  var gdCategories = [];
  var gdCart = [];
  var gdSession = { staff: '', supervisor: '', category: '' };
  var gdMatches = [];
  var gdProduct = null;
  var gdSearchToken = 0;
  var gdPending = [];
  var gdDraft = {};
  var gdCompleted = [];
  var gdSubView = 'pending';
  var gdSelPendingCat = null;
  var gdSelCompletedCat = null;
  var gdLastPendingSig = null;
  var gdLastCompletedSig = null;
  var gdCollapsed = {};
  var gdAdminPending = [];

  function gdSafe(key){ return String(key).replace(/[^a-zA-Z0-9]/g, '_'); }
  function gdNewId(prefix){ return prefix + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase(); }
  function gdErrHtml(msg){ return '<div class="status err">' + escapeHtml(msg) + '</div>'; }
  function gdOkHtml(msg){ return '<div class="status ok">' + escapeHtml(msg) + '</div>'; }

  // ---------- Categories ----------
  function gdGetCategories(){
    return sb.from('goods_categories').select('name').order('id', { ascending: true })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return res.data.map(function(r){ return r.name; });
      });
  }

  function gdPopulateCategorySelect(){
    var sel = document.getElementById('gdCategorySelect');
    if(!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">Select category...</option>';
    gdCategories.forEach(function(c){
      var o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o);
    });
    if(cur && gdCategories.indexOf(cur) !== -1) sel.value = cur;
  }

  // Startup: categories + pending (silent) + restore an unfinished entry.
  function gdInit(){
    return gdGetCategories()
      .then(function(c){
        gdCategories = c;
        gdPopulateCategorySelect();
        var d = gdLoadDraft();
        if(d && d.staff && d.supervisor && d.category && gdCategories.indexOf(d.category) !== -1){
          gdSession = { staff: d.staff, supervisor: d.supervisor, category: d.category };
          gdCart = d.cart || [];
          document.getElementById('gdStaffInput').value = d.staff;
          document.getElementById('gdSupervisorInput').value = d.supervisor;
          document.getElementById('gdCategorySelect').value = d.category;
          gdEnterStep2();
          gdRenderCart();
        }
      })
      .catch(function(err){
        var el = document.getElementById('gdStep1Status');
        if(el) el.innerHTML = gdErrHtml('Goods tables not ready: ' + err.message + ' (run goods-disposal-schema.sql in Supabase)');
      })
      .then(function(){ return gdLoadPending({ silent: true, force: true }).catch(function(){}); })
      .then(refreshHomeDashboard);
  }

  // ---------- Draft (survives refresh) ----------
  function gdSaveDraft(){
    try {
      localStorage.setItem(GD_DRAFT_KEY, JSON.stringify({
        plant: currentOutletPlant, staff: gdSession.staff, supervisor: gdSession.supervisor,
        category: gdSession.category, cart: gdCart
      }));
    } catch(e){}
  }
  function gdLoadDraft(){
    try {
      var d = JSON.parse(localStorage.getItem(GD_DRAFT_KEY) || 'null');
      if(d && d.plant === currentOutletPlant) return d;
    } catch(e){}
    return null;
  }
  function gdClearDraft(){ try { localStorage.removeItem(GD_DRAFT_KEY); } catch(e){} }

  // ---------- New Entry: steps ----------
  function gdGoToStep2(){
    var staff = document.getElementById('gdStaffInput').value.trim();
    var sup = document.getElementById('gdSupervisorInput').value.trim();
    var cat = document.getElementById('gdCategorySelect').value;
    var st = document.getElementById('gdStep1Status');
    if(!staff || !sup || !cat){
      st.innerHTML = gdErrHtml('Please fill in staff, supervisor and category.');
      return;
    }
    st.innerHTML = '';
    // Changing category/staff with items already in the list would mix them
    // into the wrong transaction, so require the list to be empty first.
    if(gdCart.length && (staff !== gdSession.staff || sup !== gdSession.supervisor || cat !== gdSession.category)){
      st.innerHTML = gdErrHtml('Your list already has items for ' + gdSession.category + '. Submit or cancel that entry before changing staff, supervisor or category.');
      return;
    }
    gdSession = { staff: staff, supervisor: sup, category: cat };
    gdEnterStep2();
    gdSaveDraft();
  }
  function gdEnterStep2(){
    document.getElementById('gdSummaryOutlet').textContent = outletLabel(currentOutletPlant);
    document.getElementById('gdSummaryStaff').textContent = gdSession.staff;
    document.getElementById('gdSummarySupervisor').textContent = gdSession.supervisor;
    document.getElementById('gdSummaryCategory').textContent = gdSession.category;
    document.getElementById('gdStep1View').style.display = 'none';
    document.getElementById('gdStep2View').style.display = 'block';
    var inp = document.getElementById('gdScanInput'); if(inp) inp.focus();
  }
  function gdBackToStep1(){
    document.getElementById('gdStep2View').style.display = 'none';
    document.getElementById('gdStep1View').style.display = 'block';
  }
  function gdCancelEntry(){
    if(gdCart.length && !confirm('Discard this entry? Items you have added but not submitted will be lost.')) return;
    gdResetEntry();
  }
  function gdResetEntry(){
    gdSession = { staff: '', supervisor: '', category: '' };
    gdCart = []; gdProduct = null; gdMatches = [];
    gdClearDraft();
    ['gdStaffInput', 'gdSupervisorInput', 'gdScanInput', 'gdQtyInput'].forEach(function(id){ document.getElementById(id).value = ''; });
    document.getElementById('gdCategorySelect').value = '';
    document.getElementById('gdReasonInput').value = '';
    document.getElementById('gdProductResult').style.display = 'none';
    document.getElementById('gdSearchHint').innerHTML = '';
    document.getElementById('gdSubmitStatus').innerHTML = '';
    gdRenderCart();
    gdBackToStep1();
  }

  // ---------- New Entry: barcode lookup ----------
  document.getElementById('gdScanInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); gdSearch(); }
  });

  // Exact EAN first; if nothing, exact Material (which can return several
  // rows - one per sales unit - so the person picks the right one).
  function gdLookup(code){
    return sb.from('goods_masterlist').select('*').eq('ean', code).limit(25)
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        if(res.data.length) return res.data;
        return sb.from('goods_masterlist').select('*').eq('material', code).order('sales_unit').limit(50)
          .then(function(r2){
            if(r2.error) throw new Error(r2.error.message);
            return r2.data;
          });
      });
  }

  function gdSearch(){
    var code = document.getElementById('gdScanInput').value.trim();
    var hint = document.getElementById('gdSearchHint');
    document.getElementById('gdProductResult').style.display = 'none';
    gdProduct = null; gdMatches = [];
    if(!code){ hint.innerHTML = gdErrHtml('Enter or scan a product code first.'); return; }
    if(!navigator.onLine){ hint.innerHTML = gdErrHtml('You are offline. Searching needs a connection.'); return; }
    var token = ++gdSearchToken;
    hint.innerHTML = '<div class="status ok"><span class="spinner"></span> Searching...</div>';
    gdLookup(code).then(function(rows){
      if(token !== gdSearchToken) return;
      if(!rows.length){
        hint.innerHTML = gdErrHtml('No product found for "' + code + '". Ask Admin to add it to the Goods masterlist.');
        return;
      }
      hint.innerHTML = '';
      gdMatches = rows;
      var wrap = document.getElementById('gdChooserWrap');
      if(rows.length > 1){
        var sel = document.getElementById('gdChooser');
        sel.innerHTML = '';
        rows.forEach(function(r, i){
          var o = document.createElement('option');
          o.value = String(i);
          o.textContent = (r.sales_unit || '-') + ' · numerator ' + (r.numerator == null ? '-' : r.numerator) + ' · ' + (r.ean || '-');
          sel.appendChild(o);
        });
        wrap.style.display = 'block';
      } else {
        wrap.style.display = 'none';
      }
      gdPickMatch(0);
      document.getElementById('gdQtyInput').value = '';
      document.getElementById('gdReasonInput').value = '';
      document.getElementById('gdProductResult').style.display = 'block';
      document.getElementById('gdQtyInput').focus();
    }).catch(function(err){
      if(token !== gdSearchToken) return;
      hint.innerHTML = gdErrHtml(err.message);
    });
  }

  function gdPickMatch(i){
    var r = gdMatches[Number(i) || 0];
    if(!r) return;
    gdProduct = r;
    document.getElementById('gdPrDesc').textContent = r.description || '-';
    document.getElementById('gdPrUnit').textContent = r.sales_unit || '-';
    document.getElementById('gdPrNum').textContent = r.numerator == null ? '-' : r.numerator;
    document.getElementById('gdPrDept').textContent = r.department || '-';
    document.getElementById('gdPrMat').textContent = r.material || '-';
    document.getElementById('gdPrEan').textContent = r.ean || '-';
    var w = document.getElementById('gdUomWarn');
    document.getElementById('gdUomChk').checked = false;
    if(w){
      document.getElementById('gdUomWarnUnit').textContent = (r.sales_unit || 'blank');
      w.style.display = gdNonEa(r.sales_unit) ? 'block' : 'none';
    }
  }

  function gdInsertItem(){
    var hint = document.getElementById('gdSearchHint');
    if(!gdProduct){ hint.innerHTML = gdErrHtml('Search for a product first.'); return; }
    var qty = Number(document.getElementById('gdQtyInput').value);
    var reason = document.getElementById('gdReasonInput').value;
    if(!qty || qty <= 0){ hint.innerHTML = gdErrHtml('Enter a valid quantity.'); return; }
    qty = Math.round(qty * 100) / 100;
    if(qty > GD_MAX_QTY){ hint.innerHTML = gdErrHtml('Quantity cannot exceed ' + GD_MAX_QTY + '.'); return; }
    if(!reason){ hint.innerHTML = gdErrHtml('Select a reason.'); return; }
    if(gdNonEa(gdProduct.sales_unit) && !document.getElementById('gdUomChk').checked){
      hint.innerHTML = gdErrHtml('UOM is not EA. Tick the box to confirm the code and UOM are correct.'); return;
    }

    var p = gdProduct;
    var existing = gdCart.find(function(it){ return it.ean === (p.ean || '') && it.material === p.material && it.reason === reason; });
    if(existing){
      var sum = Math.round((existing.qty + qty) * 100) / 100;
      if(sum > GD_MAX_QTY){ hint.innerHTML = gdErrHtml('Combined quantity for this item would exceed ' + GD_MAX_QTY + '.'); return; }
      existing.qty = sum;
    } else {
      gdCart.push({
        ean: p.ean || '', material: p.material, description: p.description || '',
        salesUnit: p.sales_unit || '', numerator: p.numerator, department: p.department || '',
        qty: qty, reason: reason
      });
    }
    hint.innerHTML = '';
    gdProduct = null; gdMatches = [];
    document.getElementById('gdProductResult').style.display = 'none';
    document.getElementById('gdScanInput').value = '';
    document.getElementById('gdScanInput').focus();
    gdRenderCart();
    gdSaveDraft();
  }

  function gdRenderCart(){
    var list = document.getElementById('gdCartList');
    document.getElementById('gdCartCount').textContent = gdCart.length;
    document.getElementById('gdCartPlural').textContent = gdCart.length === 1 ? '' : 's';
    document.getElementById('gdCartEmpty').style.display = gdCart.length ? 'none' : 'block';
    document.getElementById('gdSubmitBtn').disabled = !gdCart.length;
    list.innerHTML = gdCart.map(function(it, idx){
      return '<div class="cart-item">' +
        '<div class="cart-top">' +
          '<div style="min-width:0;">' +
            '<div class="cart-desc">' + escapeHtml(it.description || '(no description)') + '</div>' +
            '<div class="cart-sub">Material ' + escapeHtml(it.material) + ' &middot; ' + escapeHtml(it.ean || '-') + ' &middot; ' + escapeHtml(it.salesUnit || '-') + '</div>' +
            '<div class="cart-sub"><span class="cat-tag">' + escapeHtml(it.reason) + '</span></div>' +
          '</div>' +
          '<div class="cart-total"><small>Qty</small><input type="number" class="gd-cart-qty" min="1" max="' + GD_MAX_QTY + '" step="1" value="' + it.qty + '" data-idx="' + idx + '"></div>' +
          '<span class="remove-btn" data-idx="' + idx + '" onclick="gdRemoveCartItem(this)">&times;</span>' +
        '</div></div>';
    }).join('');
  }
  document.getElementById('gdCartList').addEventListener('change', function(e){
    if(!e.target.classList.contains('gd-cart-qty')) return;
    var idx = parseInt(e.target.dataset.idx, 10);
    var v = Number(e.target.value);
    if(!v || v <= 0 || v > GD_MAX_QTY){
      e.target.value = gdCart[idx].qty;
      alert('Quantity must be between 1 and ' + GD_MAX_QTY + '.');
      return;
    }
    gdCart[idx].qty = Math.round(v * 100) / 100;
    gdSaveDraft();
  });
  function gdRemoveCartItem(el){
    var idx = parseInt(el.dataset.idx, 10);
    gdCart.splice(idx, 1);
    gdRenderCart();
    gdSaveDraft();
  }

  // ---------- New Entry: submit ----------
  function gdDayRows(plant, category, staff, supervisor, when){
    var b = dayBoundsISO(when);
    return sb.from('bad_stock_goods').select('id, batch_id, ean, material, reason, quantity, ref_no')
      .eq('status', 'pending').eq('plant', plant).eq('category', category)
      .eq('staff', staff).eq('supervisor', supervisor)
      .gte('entry_date', b.startISO).lt('entry_date', b.endISO)
      .order('id', { ascending: true })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return res.data;
      });
  }

  // Same-day stacking: same outlet + category + staff + supervisor joins
  // the existing pending transaction; same barcode + reason sums quantity.
  function gdSubmitToSupabase(plant, category, staff, supervisor, items){
    var when = new Date();
    return gdDayRows(plant, category, staff, supervisor, when).then(function(rows){
     var refP = rows.length ? Promise.resolve(rows[0].ref_no || null) : genRefNo(plant, '02');
     return refP.then(function(refNo){
      var batchId = rows.length ? rows[0].batch_id : gdNewId('G');
      var byKey = {};
      rows.filter(function(r){ return r.batch_id === batchId; }).forEach(function(r){
        byKey[(r.ean || '') + '|' + (r.material || '') + '|' + r.reason] = r;
      });
      var ops = [], newRows = [];
      items.forEach(function(it){
        var ex = byKey[it.ean + '|' + it.material + '|' + it.reason];
        if(ex){
          var q = Math.round((Number(ex.quantity) + it.qty) * 100) / 100;
          ops.push(sb.from('bad_stock_goods').update({ quantity: q }).eq('id', ex.id));
        } else {
          newRows.push({
            batch_id: batchId, entry_date: when.toISOString(), category: category,
            staff: staff, supervisor: supervisor, ean: it.ean, material: it.material,
            description: it.description, sales_unit: it.salesUnit,
            numerator: (it.numerator === '' || it.numerator == null) ? null : it.numerator,
            department: it.department, quantity: it.qty, reason: it.reason,
            plant: plant, sloc: '1000', status: 'pending', ref_no: refNo
          });
        }
      });
      if(newRows.length) ops.push(sb.from('bad_stock_goods').insert(newRows));
      return Promise.all(ops).then(function(results){
        results.forEach(function(r){ if(r.error) throw new Error(r.error.message); });
        return true;
      });
     });
    });
  }

  function gdSubmitCart(){
    var st = document.getElementById('gdSubmitStatus');
    if(!gdCart.length) return;
    if(!navigator.onLine){
      st.innerHTML = gdErrHtml('You are offline. Your list is saved on this device - submit again once the connection returns.');
      return;
    }
    var items = gdCart.slice();
    var s = { staff: gdSession.staff, supervisor: gdSession.supervisor, category: gdSession.category };
    document.getElementById('gdSubmitBtn').disabled = true;
    st.innerHTML = '';
    showBusy('Submitting goods entry...');
    gdSubmitToSupabase(currentOutletPlant, s.category, s.staff, s.supervisor, items)
      .then(function(){
        hideBusy();
        gdCart = [];
        gdClearDraft();
        gdLastPendingSig = null;
        gdLoadPending({ silent: true, force: true }).catch(function(){}).then(refreshHomeDashboard);
        gdShowSummary(s, items, function(){ gdResetEntry(); });
      })
      .catch(function(err){
        hideBusy();
        document.getElementById('gdSubmitBtn').disabled = false;
        st.innerHTML = gdErrHtml('Error: ' + err.message + ' - check Disposal Records > Goods before submitting again.');
      });
  }

  function gdShowSummary(s, items, onClose){
    var old = document.getElementById('submitSummaryOverlay');
    if(old) old.parentNode.removeChild(old);
    var overlay = document.createElement('div');
    overlay.id = 'submitSummaryOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999;';
    overlay.innerHTML =
      '<div class="card" style="max-width:420px;width:100%;margin:0;max-height:90vh;overflow:auto;">' +
        '<h2 style="margin-top:0;">&#10003; Submitted successfully</h2>' +
        '<div class="pending-meta"><b>' + escapeHtml(s.staff) + '</b> &middot; ' + escapeHtml(s.supervisor) + '</div>' +
        '<table style="margin-top:10px;"><thead><tr><th>Category</th><th style="text-align:right;">Items</th></tr></thead>' +
        '<tbody><tr><td>' + escapeHtml(s.category) + '</td><td style="text-align:right;">' + items.length + '</td></tr></tbody></table>' +
        '<button class="btn btn-full" id="gdSummaryOk">OK</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('gdSummaryOk').addEventListener('click', function(){
      overlay.parentNode.removeChild(overlay);
      if(onClose) onClose();
    });
  }

  // ---------- Disposal Records (Goods): data ----------
  function gdGroupRows(rows, completed){
    var batches = {}, order = [];
    rows.forEach(function(row){
      if(!batches[row.batch_id]){
        batches[row.batch_id] = {
          txnId: row.batch_id, category: row.category, staff: row.staff, supervisor: row.supervisor,
          refNo: row.ref_no || '', deletedAt: row.deleted_at || null,
          entryDate: row.entry_date, dateDisplay: formatDateDisplay(row.entry_date),
          materialDocument: completed ? (row.material_document || '') : '',
          keyInBy: row.key_in_by || '',
          revertedAt: row.reverted_at || null,
          revertedDoc: row.reverted_doc || '',
          items: []
        };
        order.push(row.batch_id);
      }
      batches[row.batch_id].items.push({
        id: row.id, ean: row.ean || '', material: row.material || '', description: row.description || '',
        salesUnit: row.sales_unit || '', numerator: row.numerator, department: row.department || '',
        qty: Number(row.quantity), reason: row.reason
      });
    });
    return order.map(function(k){ return sortItemsById(batches[k]); });
  }

  function gdGetPendingFromSupabase(status){
    return sb.from('bad_stock_goods').select('*').eq('status', status || 'pending').eq('plant', currentOutletPlant)
      .order('entry_date', { ascending: true }).order('id', { ascending: true })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return gdGroupRows(res.data, false);
      });
  }

  function gdGetCompletedFromSupabase(fromStr, toStr){
    var from = new Date(fromStr + 'T00:00:00');
    var to = new Date(toStr + 'T23:59:59.999');
    return sb.from('bad_stock_goods').select('*').eq('status', 'keyed_in').eq('plant', currentOutletPlant)
      .gte('entry_date', from.toISOString()).lte('entry_date', to.toISOString())
      .order('entry_date', { ascending: false }).order('id', { ascending: true })
      .then(function(res){
        if(res.error) throw new Error(res.error.message);
        return gdGroupRows(res.data, true);
      });
  }

  function gdLoadPending(opts){
    opts = opts || {};
    var silent = !!opts.silent;
    if(!silent){
      document.getElementById('gdCategoryPicker').innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
      document.getElementById('gdPendingList').innerHTML = '';
      document.getElementById('gdPendingEmpty').style.display = 'none';
      document.getElementById('gdPendingCategoryEmpty').style.display = 'none';
    }
    return gdGetPendingFromSupabase().then(function(entries){
      var sig = JSON.stringify(entries);
      if(silent && !opts.force && sig === gdLastPendingSig) return;
      gdLastPendingSig = sig;

      // keep just-submitted cards (Print Here) through refreshes
      var kept = (silent || opts.force) ? gdPending.filter(function(b){
        var d = gdDraft[b.txnId];
        return d && d.submitted && !entries.some(function(e){ return e.txnId === b.txnId; });
      }) : [];
      gdPending = entries.concat(kept);
      document.getElementById('gdPendingCount').textContent = entries.length;

      entries.forEach(function(batch){
        var key = batch.txnId;
        var d = gdDraft[key];
        if(!d){
          gdDraft[key] = {
            items: batch.items.map(function(it){ return Object.assign({}, it, { dirty: false }); }),
            removedIds: [], materialDocument: '', keyInBy: '', submitted: null
          };
        } else if(!d.submitted && !editMode[key]){
          var freshById = {}, seen = {};
          batch.items.forEach(function(f){ freshById[f.id] = f; });
          d.items.forEach(function(it){
            seen[it.id] = true;
            var f = freshById[it.id];
            if(f && !it.dirty) it.qty = f.qty;
          });
          batch.items.forEach(function(f){
            if(!seen[f.id] && d.removedIds.indexOf(f.id) === -1) d.items.push(Object.assign({}, f, { dirty: false }));
          });
        }
      });

      if(gdSelPendingCat && !gdPending.some(function(b){ return b.category === gdSelPendingCat; })) gdSelPendingCat = null;
      gdRenderCategoryPicker();
      gdRenderPendingFiltered();
      gdUpdateRecordCounts();
    }).catch(function(err){
      if(silent) throw err;
      document.getElementById('gdCategoryPicker').innerHTML = '';
      document.getElementById('gdPendingList').innerHTML = gdErrHtml('Failed to load pending goods entries: ' + err.message);
    });
  }

  function gdUpdateRecordCounts(){
    var fm = document.getElementById('recCountFm');
    var gd = document.getElementById('recCountGd');
    if(fm) fm.textContent = String(homeFmPendingCount());
    if(gd) gd.textContent = String(gdPending.filter(function(b){ var d = gdDraft[b.txnId]; return !(d && d.submitted); }).length);
    revUpdateCount();
  }

  function gdRenderCategoryPicker(){
    var picker = document.getElementById('gdCategoryPicker');
    picker.innerHTML = '';
    gdCategories.forEach(function(cat){
      var count = gdPending.filter(function(b){ return b.category === cat; }).length;
      var chip = document.createElement('div');
      chip.className = 'category-chip' + (gdSelPendingCat === cat ? ' active' : '');
      chip.innerHTML = escapeHtml(cat) + ' <span class="count">' + count + '</span>';
      chip.onclick = function(){ if(gdSelPendingCat !== cat && editingBlocked()) return; gdSelPendingCat = cat; gdRenderCategoryPicker(); gdRenderPendingFiltered(); };
      picker.appendChild(chip);
    });
  }

  function gdRenderPendingFiltered(){
    gdRenderPendingFilteredBase();
    renderRevertedList();
  }
  function gdRenderPendingFilteredBase(){
    var container = document.getElementById('gdPendingList');
    var emptyEl = document.getElementById('gdPendingEmpty');
    var catEmpty = document.getElementById('gdPendingCategoryEmpty');
    if(!gdSelPendingCat){
      container.innerHTML = ''; emptyEl.style.display = 'none'; catEmpty.style.display = 'block'; return;
    }
    catEmpty.style.display = 'none';
    var filtered = gdPending.filter(function(b){ return b.category === gdSelPendingCat; });
    if(!filtered.length){ container.innerHTML = ''; emptyEl.style.display = 'block'; return; }
    emptyEl.style.display = 'none';
    gdRenderPendingList(filtered);
  }

  function gdSwitchSubView(view){
    if(view !== gdSubView && editingBlocked()) return;
    gdSubView = view;
    document.getElementById('gdPendingSubView').style.display = view === 'pending' ? 'block' : 'none';
    document.getElementById('gdCompletedSubView').style.display = view === 'completed' ? 'block' : 'none';
    document.getElementById('gdHeaderPending').style.display = view === 'pending' ? 'block' : 'none';
    document.getElementById('gdHeaderCompleted').style.display = view === 'completed' ? 'block' : 'none';
    document.getElementById('gdSubTabPending').classList.toggle('active', view === 'pending');
    document.getElementById('gdSubTabCompleted').classList.toggle('active', view === 'completed');
    if(view === 'completed') gdInitCompletedDates();
  }

  function gdDateValue(d){
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function gdInitCompletedDates(){
    var f = document.getElementById('gdCompletedDateFrom'), t = document.getElementById('gdCompletedDateTo');
    if(f.value && t.value) return;
    var from = new Date(); from.setDate(from.getDate() - 30);
    f.value = gdDateValue(from); t.value = gdDateValue(new Date());
  }
  function gdRunCompleted(){
    var f = document.getElementById('gdCompletedDateFrom').value;
    var t = document.getElementById('gdCompletedDateTo').value;
    var st = document.getElementById('gdCompletedDateStatus');
    if(!f || !t){ st.innerHTML = gdErrHtml('Please select both Date From and Date To.'); return; }
    if(f > t){ st.innerHTML = gdErrHtml('Date From must be on or before Date To.'); return; }
    st.innerHTML = '';
    gdLoadCompleted(f, t);
  }

  function gdLoadCompleted(fromVal, toVal, opts){
    opts = opts || {};
    var silent = !!opts.silent;
    fromVal = fromVal || document.getElementById('gdCompletedDateFrom').value;
    toVal = toVal || document.getElementById('gdCompletedDateTo').value;
    if(!fromVal || !toVal) return Promise.resolve();
    if(!silent){
      document.getElementById('gdCompletedCategoryPicker').innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
      document.getElementById('gdCompletedList').innerHTML = '';
      document.getElementById('gdCompletedEmpty').style.display = 'none';
      document.getElementById('gdCompletedCategoryEmpty').style.display = 'none';
    }
    return gdGetCompletedFromSupabase(fromVal, toVal).then(function(entries){
      var sig = fromVal + '|' + toVal + '|' + JSON.stringify(entries);
      if(silent && !opts.force && sig === gdLastCompletedSig) return;
      gdLastCompletedSig = sig;
      gdCompleted = entries;
      document.getElementById('gdCompletedCount').textContent = entries.length;
      if(gdSelCompletedCat && !entries.some(function(b){ return b.category === gdSelCompletedCat; })) gdSelCompletedCat = null;
      gdRenderCompletedCategoryPicker();
      gdRenderCompletedFiltered();
    }).catch(function(err){
      if(silent) throw err;
      document.getElementById('gdCompletedCategoryPicker').innerHTML = '';
      document.getElementById('gdCompletedList').innerHTML = gdErrHtml('Failed to load completed goods entries: ' + err.message);
    });
  }

  function gdRenderCompletedCategoryPicker(){
    var picker = document.getElementById('gdCompletedCategoryPicker');
    picker.innerHTML = '';
    gdCategories.forEach(function(cat){
      var count = gdCompleted.filter(function(b){ return b.category === cat; }).length;
      var chip = document.createElement('div');
      chip.className = 'category-chip' + (gdSelCompletedCat === cat ? ' active' : '');
      chip.innerHTML = escapeHtml(cat) + ' <span class="count">' + count + '</span>';
      chip.onclick = function(){ gdSelCompletedCat = cat; gdRenderCompletedCategoryPicker(); gdRenderCompletedFiltered(); };
      picker.appendChild(chip);
    });
  }

  function gdRenderCompletedFiltered(){
    var container = document.getElementById('gdCompletedList');
    var emptyEl = document.getElementById('gdCompletedEmpty');
    var catEmpty = document.getElementById('gdCompletedCategoryEmpty');
    if(!gdSelCompletedCat){
      container.innerHTML = ''; emptyEl.style.display = 'none'; catEmpty.style.display = 'block'; return;
    }
    catEmpty.style.display = 'none';
    var filtered = gdCompleted.filter(function(b){ return b.category === gdSelCompletedCat; });
    if(!filtered.length){ container.innerHTML = ''; emptyEl.style.display = 'block'; return; }
    emptyEl.style.display = 'none';
    container.innerHTML = '';
    filtered.forEach(function(batch){
      var key = batch.txnId;
      gdDraft[key] = {
        items: batch.items, removedIds: [], materialDocument: batch.materialDocument, keyInBy: batch.keyInBy,
        submitted: gdPrintData(batch, batch.materialDocument, batch.keyInBy, batch.items)
      };
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="pending-card-header"><div><span class="cat-tag">' + escapeHtml(batch.category) + '</span>' + refTag(batch) + '</div>' +
        '<div class="pending-meta">' + escapeHtml(batch.dateDisplay) + '</div></div>' +
        '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(batch.staff) + '</b> &middot; ' + escapeHtml(batch.supervisor) +
        ' &middot; ' + batch.items.length + ' item' + (batch.items.length === 1 ? '' : 's') + '</div>' +
        '<div class="status ok" style="margin-top:12px;">Completed &middot; Material Document ' + escapeHtml(batch.materialDocument) + '</div>' +
        '<button class="btn secondary btn-full" onclick="gdPrintBatch(\'' + key + '\')">Print Here</button>';
      container.appendChild(card);
    });
  }

  // ---------- Pending cards ----------
  function gdIsCollapsed(key, n){
    if(gdCollapsed[key] !== undefined) return gdCollapsed[key];
    return n > 1;
  }
  function gdToggleCard(headerEl, key){
    var body = headerEl.parentNode.querySelector('.pending-body');
    if(!body) return;
    var nowCollapsed = body.style.display !== 'none';
    body.style.display = nowCollapsed ? 'none' : '';
    gdCollapsed[key] = nowCollapsed;
    var chev = headerEl.querySelector('.pending-chevron');
    if(chev) chev.textContent = nowCollapsed ? '▸' : '▾';
  }

  function gdRenderPendingList(batches, containerId){
    var container = document.getElementById(containerId || 'gdPendingList');
    container.innerHTML = '';
    batches.forEach(function(batch){
      var key = batch.txnId;
      var d = gdDraft[key];
      var card = document.createElement('div');
      card.className = 'card';
      card.id = 'pcard_' + gdSafe(key);

      if(d.submitted){
        delete editMode[key];
        card.innerHTML =
          '<div class="pending-card-header"><div><span class="cat-tag">' + escapeHtml(batch.category) + '</span>' + refTag(batch) + '</div>' +
          '<div class="pending-meta">' + escapeHtml(batch.dateDisplay) + '</div></div>' +
          '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(batch.staff) + '</b> &middot; ' + escapeHtml(batch.supervisor) + '</div>' +
          '<div class="status ok" style="margin-top:12px;">Completed &middot; Material Document ' + escapeHtml(d.materialDocument) + '</div>' +
          '<button class="btn secondary btn-full" onclick="gdPrintBatch(\'' + key + '\')">Print Here</button>';
        container.appendChild(card);
        return;
      }

      var editing = !!editMode[key];
      var itemsHtml = d.items.map(function(it, idx){
        return '<tr>' +
          '<td>' + escapeHtml(it.description || '(no description)') +
            '<div class="sap-reason-note">Material ' + escapeHtml(it.material) + ' &middot; ' + escapeHtml(it.ean || '-') + '</div></td>' +
          '<td>' + (gdNonEa(it.salesUnit) ? '<span class="uom-warn">&#9888; ' + escapeHtml(it.salesUnit || 'blank') + '</span>' : escapeHtml(it.salesUnit || '—')) + '</td>' +
          '<td>' + (editing
            ? '<input type="number" min="1" max="' + GD_MAX_QTY + '" step="1" value="' + it.qty + '" data-key="' + key + '" data-idx="' + idx + '" class="gd-pending-qty">'
            : escapeHtml(String(it.qty))) + '</td>' +
          '<td>' + escapeHtml(it.reason) + '</td>' +
          '<td>' + (editing ? '<span class="remove-btn" data-key="' + key + '" data-idx="' + idx + '" onclick="gdRemovePendingItem(this)">&times;</span>' : '') + '</td>' +
        '</tr>';
      }).join('');

      var safeKey = gdSafe(key);
      var collapsed = gdIsCollapsed(key, batches.length);
      card.innerHTML =
        '<div class="pending-toggle" onclick="gdToggleCard(this, \'' + key + '\')">' +
          '<div class="pending-card-header"><div>' + revTypeTag(batch, 'Goods') + '<span class="cat-tag">' + escapeHtml(batch.category) + '</span>' + refTag(batch) + '</div>' +
          '<div class="pending-meta">' + escapeHtml(batch.dateDisplay) + ' <span class="pending-chevron">' + (collapsed ? '▸' : '▾') + '</span></div></div>' +
          '<div class="pending-meta pending-meta-row" style="margin-top:6px;"><span><b>' + escapeHtml(batch.staff) + '</b> &middot; ' + escapeHtml(batch.supervisor) +
          ' &middot; ' + d.items.length + ' item' + (d.items.length === 1 ? '' : 's') + '</span>' + editActionsHtml('gd', key, editing) + '</div>' +
        '</div>' +
        '<div class="pending-body"' + (collapsed ? ' style="display:none;"' : '') + '>' +
        revNoteHtml(batch) +
        '<table><thead><tr><th>Description</th><th>Unit</th><th>Qty</th><th>Reason</th><th></th></tr></thead><tbody>' + itemsHtml + '</tbody></table>' +
        (editing
          ? '<button class="btn secondary btn-full" onclick="gdSaveChanges(\'' + key + '\')">Save Changes</button>' +
            '<button class="btn ghost btn-full" onclick="cancelEdit(\'gd\', \'' + key + '\')">Cancel</button>'
          : '') +
        (editing ? gdAddPanelHtml(key) : '') +
        '<div id="gdSaveStatus_' + safeKey + '"></div>' +
        gdUomWarnHtml(key, d) +
        gdSapSectionHtml(key, d) +
        '<hr class="divider">' +
        '<label>Material Document</label>' +
        '<input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" class="gd-matdoc' + (gdUomLocked(d) ? ' locked-input' : '') + '" data-key="' + key + '" value="' + escapeHtml(d.materialDocument) + '" placeholder="Enter material document number (numbers only)"' + (gdUomLocked(d) ? ' disabled' : '') + '>' +
        '<label>Key In By</label>' +
        '<input type="text" class="gd-keyinby' + (gdUomLocked(d) ? ' locked-input' : '') + '" data-key="' + key + '" value="' + escapeHtml(d.keyInBy) + '" placeholder="Enter your name"' + (gdUomLocked(d) ? ' disabled' : '') + '>' +
        '<button class="btn btn-full"' + (gdUomLocked(d) ? ' disabled' : '') + ' onclick="gdSubmitBatch(\'' + key + '\')">Submit</button>' +
        '<div id="gdSubmitStatus_' + safeKey + '"></div>' +
        '</div>';
      container.appendChild(card);
    });

    container.querySelectorAll('.gd-pending-qty').forEach(function(input){
      input.addEventListener('change', function(){
        var it = gdDraft[input.dataset.key].items[parseInt(input.dataset.idx, 10)];
        var v = Number(input.value);
        if(!v || v <= 0 || v > GD_MAX_QTY){
          input.value = it.qty;
          alert('Quantity must be between 1 and ' + GD_MAX_QTY + '.');
          return;
        }
        it.qty = Math.round(v * 100) / 100;
        it.dirty = true;
        input.value = it.qty;
      });
    });
    container.querySelectorAll('.gd-matdoc').forEach(function(input){
      input.addEventListener('input', function(){
        var digits = input.value.replace(/\D/g, ''); // numbers only (also cleans pasted text)
        if(digits !== input.value) input.value = digits;
        gdDraft[input.dataset.key].materialDocument = digits;
      });
    });
    container.querySelectorAll('.gd-keyinby').forEach(function(input){
      input.addEventListener('input', function(){ gdDraft[input.dataset.key].keyInBy = input.value; });
    });
  }


  // ---------- Add item to an existing Goods transaction (edit mode) ----------

  // ---------- UOM other than EA: soft warning + confirmation ----------
  function gdNonEa(u){ return String(u == null ? '' : u).trim().toUpperCase() !== 'EA'; }
  function gdUomLocked(d){ return !d.submitted && d.items.some(function(it){ return gdNonEa(it.salesUnit); }) && !d.uomOk; }
  function gdUomWarnHtml(key, d){
    var odd = d.items.filter(function(it){ return gdNonEa(it.salesUnit); });
    if(!odd.length) return '';
    return '<div class="uom-warn-box">' +
      '<div class="uom-warn">&#9888; UOM other than EA: ' + odd.map(function(it){ return escapeHtml((it.description || it.material) + ' (' + (it.salesUnit || 'blank') + ')'); }).join(', ') + '</div>' +
      '<label><input type="checkbox" ' + (d.uomOk ? 'checked ' : '') + 'onchange="gdUomConfirm(\'' + key + '\', this.checked)"> I confirm the code and UOM are correct</label>' +
      (d.uomOk ? '' : '<div class="sap-reason-note" style="margin-top:6px;">Copy Batch, Material Document, Key In By and Submit stay locked until you tick.</div>') +
      '</div>';
  }
  function gdUomConfirm(key, on){
    var d = gdDraft[key]; if(!d) return;
    d.uomOk = !!on;
    gdRenderPendingFiltered();
  }

  var gdAddState = {};
  function gdAddPanelHtml(key){
    var sk = gdSafe(key);
    return '<div class="lookup-preview" style="display:block;margin-top:12px;">' +
      '<label style="margin-top:0;">Add item (barcode or material)</label>' +
      '<div class="btn-row" style="flex-wrap:nowrap;">' +
        '<input type="text" id="gdAddCode_' + sk + '" placeholder="Scan barcode or enter Material / Product Code" autocomplete="off" style="flex:1;" onkeydown="if(event.key===\'Enter\'){event.preventDefault();gdAddSearch(\'' + key + '\');}">' +
        '<button class="btn ghost" style="margin-top:0;" onclick="gdAddSearch(\'' + key + '\')">Search</button>' +
      '</div>' +
      '<div id="gdAddRes_' + sk + '"></div></div>';
  }
  function gdAddSearch(key){
    var sk = gdSafe(key), res = document.getElementById('gdAddRes_' + sk);
    var code = document.getElementById('gdAddCode_' + sk).value.trim();
    if(!code){ res.innerHTML = gdErrHtml('Enter or scan a product code first.'); return; }
    res.innerHTML = '<div class="status ok"><span class="spinner"></span> Searching...</div>';
    gdLookup(code).then(function(rows){
      if(!rows.length){ res.innerHTML = gdErrHtml('No product found for "' + code + '". Ask Admin to add it to the Goods masterlist.'); gdAddState[key] = null; return; }
      gdAddState[key] = { rows: rows, sel: 0 };
      var h = '';
      if(rows.length > 1){
        h += '<label>Several units found &mdash; choose one</label><select id="gdAddSel_' + sk + '" onchange="gdAddPick(\'' + key + '\', this.value)">' +
          rows.map(function(x, i){ return '<option value="' + i + '">' + escapeHtml((x.sales_unit || '-') + ' \u00B7 numerator ' + (x.numerator == null ? '-' : x.numerator) + ' \u00B7 ' + (x.ean || '-')) + '</option>'; }).join('') + '</select>';
      }
      h += '<div id="gdAddInfo_' + sk + '"></div>' +
        '<div class="gd-prod-form"><div><label>Quantity</label><input type="number" id="gdAddQty_' + sk + '" min="1" max="' + GD_MAX_QTY + '" step="1" placeholder="Qty"></div>' +
        '<div><label>Reason</label><select id="gdAddReason_' + sk + '"><option value="">Select reason...</option><option value="Damaged">Damaged</option><option value="Expired">Expired</option><option value="Buy 1 Free 1">Buy 1 Free 1</option><option value="Others">Others</option></select></div>' +
        '<button class="btn" onclick="gdAddInsert(\'' + key + '\')">Add</button></div>';
      res.innerHTML = h;
      gdAddPick(key, 0);
    }).catch(function(err){ res.innerHTML = gdErrHtml(err.message); });
  }
  function gdAddPick(key, i){
    var st = gdAddState[key]; if(!st) return;
    st.sel = Number(i) || 0;
    var p = st.rows[st.sel];
    document.getElementById('gdAddInfo_' + gdSafe(key)).innerHTML =
      '<div class="pending-meta" style="margin-top:8px;"><b>' + escapeHtml(p.description || '-') + '</b><br>Material ' + escapeHtml(p.material || '-') +
      ' &middot; ' + escapeHtml(p.ean || '-') + ' &middot; ' + escapeHtml(p.sales_unit || '-') + '</div>';
  }
  function gdAddInsert(key){
    var sk = gdSafe(key), res = document.getElementById('gdAddRes_' + sk), st = gdAddState[key], d = gdDraft[key];
    if(!st || !d) return;
    var p = st.rows[st.sel];
    var qty = Number(document.getElementById('gdAddQty_' + sk).value);
    var reason = document.getElementById('gdAddReason_' + sk).value;
    var err = function(m){ var e = document.getElementById('gdAddMsg_' + sk); if(!e){ e = document.createElement('div'); e.id = 'gdAddMsg_' + sk; res.appendChild(e); } e.innerHTML = gdErrHtml(m); };
    if(!qty || qty <= 0){ err('Enter a valid quantity.'); return; }
    qty = Math.round(qty * 100) / 100;
    if(qty > GD_MAX_QTY){ err('Quantity cannot exceed ' + GD_MAX_QTY + '.'); return; }
    if(!reason){ err('Select a reason.'); return; }
    if(gdNonEa(p.sales_unit) && !confirm('UOM is ' + (p.sales_unit || 'blank') + ', not EA.\n\n' + (p.description || p.material) + '\n\nAre the code and UOM correct?')) return;
    if(gdNonEa(p.sales_unit)) d.uomOk = false;
    var ex = d.items.find(function(it){ return it.ean === (p.ean || '') && it.material === p.material && it.reason === reason; });
    if(ex){
      var sum = Math.round((ex.qty + qty) * 100) / 100;
      if(sum > GD_MAX_QTY){ err('Combined quantity for this item would exceed ' + GD_MAX_QTY + '.'); return; }
      ex.qty = sum; ex.dirty = true;
    } else {
      d.items.push({
        ean: p.ean || '', material: p.material, description: p.description || '', salesUnit: p.sales_unit || '',
        numerator: p.numerator, department: p.department || '', qty: qty, reason: reason, dirty: false
      });
    }
    gdAddState[key] = null;
    gdRenderPendingFiltered();
  }

  function gdRemovePendingItem(el){
    var d = gdDraft[el.dataset.key];
    var idx = parseInt(el.dataset.idx, 10);
    if(d.items.length <= 1){
      alert('A transaction must have at least one item. To remove the whole transaction use Admin > Delete Pending Goods Transaction.');
      return;
    }
    var it = d.items[idx];
    if(!confirm('Remove this item?\n\n' + (it.description || it.material) + '\nQty ' + it.qty + ' ' + (it.salesUnit || '') + ' · ' + it.reason +
        '\n\nIt will be removed when you tap Save Changes or Submit.')) return;
    d.items.splice(idx, 1);
    if(it.id) d.removedIds.push(it.id);
    gdRenderPendingFiltered();
  }

  // Writes qty edits + removals for one transaction.
  function gdPersistDraft(key){
    var d = gdDraft[key];
    var ops = [];
    d.items.forEach(function(it){
      if(it.id && it.dirty) ops.push(sb.from('bad_stock_goods').update({ quantity: it.qty }).eq('id', it.id));
    });
    if(d.removedIds.length) ops.push(sb.from('bad_stock_goods').delete().in('id', d.removedIds));
    var fresh = d.items.filter(function(it){ return !it.id; });
    var batch = gdFindBatch(key);
    if(fresh.length){
      if(!batch) return Promise.reject(new Error('Transaction not found.'));
      var rows = fresh.map(function(it){
        return {
          batch_id: key, entry_date: batch.entryDate || new Date().toISOString(), category: batch.category,
          staff: batch.staff, supervisor: batch.supervisor, ean: it.ean, material: it.material,
          description: it.description, sales_unit: it.salesUnit,
          numerator: (it.numerator === '' || it.numerator == null) ? null : it.numerator,
          department: it.department, quantity: it.qty, reason: it.reason,
          plant: currentOutletPlant, sloc: '1000', status: batch.reverted ? 'reverted' : 'pending',
          reverted_at: batch.revertedAt || null, reverted_doc: batch.revertedDoc || null,
          ref_no: batch.refNo || null
        };
      });
      ops.push(sb.from('bad_stock_goods').insert(rows).select('id').then(function(res){
        if(!res.error && res.data) res.data.forEach(function(row, i){ if(fresh[i]) fresh[i].id = row.id; });
        return res;
      }));
    }
    return Promise.all(ops).then(function(results){
      results.forEach(function(r){ if(r.error) throw new Error(r.error.message); });
      d.items.forEach(function(it){ it.dirty = false; });
      d.removedIds = [];
    });
  }

  function gdSaveChanges(key){
    var st = document.getElementById('gdSaveStatus_' + gdSafe(key));
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Saving...</div>';
    gdPersistDraft(key).then(function(){
      gdLastPendingSig = null;
      delete editMode[key];
      gdRenderPendingFiltered();
      var st2 = document.getElementById('gdSaveStatus_' + gdSafe(key));
      if(st2){ st2.innerHTML = gdOkHtml('Changes saved.'); setTimeout(function(){ st2.innerHTML = ''; }, 1500); }
    }).catch(function(err){
      st.innerHTML = gdErrHtml('Error: ' + err.message);
    });
  }

  // ---------- Duplicate material document check (both disposal types) ----------
  function gdFindDuplicateDoc(doc, ownKey){
    return Promise.all([
      sb.from('bad_stock_goods').select('batch_id, category, staff, entry_date, plant').eq('material_document', doc).neq('batch_id', ownKey).limit(1),
      sb.from('bad_stock_fresh_market').select('batch_id, category, staff, entry_date, plant').eq('material_document', doc).limit(1)
    ]).then(function(rs){
      rs.forEach(function(r){ if(r.error) throw new Error(r.error.message); });
      var g = rs[0].data[0], f = rs[1].data[0];
      if(g) return 'Goods: ' + (g.category || '-') + ', ' + (g.staff || '-') + ', ' + formatDateDisplay(g.entry_date) + ' (' + g.plant + ')';
      if(f) return 'Fresh Market: ' + (f.category || '-') + ', ' + (f.staff || '-') + ', ' + formatDateDisplay(f.entry_date) + ' (' + f.plant + ')';
      return null;
    });
  }

  function gdPrintData(batch, doc, keyInBy, items){
    return {
      date: batch.dateDisplay, category: batch.category, staff: batch.staff, supervisor: batch.supervisor, refNo: batch.refNo || '',
      materialDocument: doc || '', keyInBy: keyInBy || '', items: items
    };
  }

  function gdSubmitBatch(key){
    if(editMode[key]){ alert('Finish editing first: tap Save Changes, or Cancel.'); return; }
    var d = gdDraft[key];
    if(d && gdUomLocked(d)){ alert('Tick the UOM confirmation first.'); return; }
    var batch = gdFindBatch(key);
    var st = document.getElementById('gdSubmitStatus_' + gdSafe(key));
    if(!d || !batch) return;
    var focus = function(cls){ var f = document.querySelector('.' + cls + '[data-key="' + key + '"]'); if(f) f.focus(); };
    if(!d.materialDocument || !d.materialDocument.trim()){ st.innerHTML = gdErrHtml('Material Document is required.'); focus('gd-matdoc'); return; }
    if(!/^\d+$/.test(d.materialDocument.trim())){ st.innerHTML = gdErrHtml('Material Document must be numbers only.'); focus('gd-matdoc'); return; }
    if(!d.keyInBy || !d.keyInBy.trim()){ st.innerHTML = gdErrHtml('Key In By is required.'); focus('gd-keyinby'); return; }
    if(/^[\d\s]+$/.test(d.keyInBy.trim())){ st.innerHTML = gdErrHtml('Key In By should be your name, not a number. Please check you did not swap it with the Material Document.'); focus('gd-keyinby'); return; }
    var doc = d.materialDocument.trim(), by = d.keyInBy.trim();
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Checking...</div>';
    showBusy('Submitting transaction...');

    gdFindDuplicateDoc(doc, key).then(function(dup){
      if(dup){
        hideBusy();
        if(!confirm('Material Document ' + doc + ' is already used by another transaction:\n\n' + dup + '\n\nThis may be a typo. Submit anyway?')){
          st.innerHTML = gdErrHtml('Cancelled. Please check the Material Document number.');
          focus('gd-matdoc');
          return null;
        }
        showBusy('Submitting transaction...');
      }
      return gdPersistDraft(key).then(function(){
        return sb.from('bad_stock_goods').update({
          material_document: doc, key_in_by: by, key_in_date: new Date().toISOString(), status: 'keyed_in'
        }).eq('batch_id', key);
      }).then(function(res){
        if(res.error) throw new Error(res.error.message);
        d.submitted = gdPrintData(batch, doc, by, d.items);
        d.materialDocument = doc; d.keyInBy = by;
        st.innerHTML = '';
        hideBusy();
        gdRenderPendingFiltered();
        gdUpdateRecordCounts();
        refreshHomeDashboard();
      });
    }).catch(function(err){
      hideBusy();
      st.innerHTML = gdErrHtml('Error: ' + err.message);
    });
  }

  // ---------- Copy to SAP (Material, Qty, UOM, Plant, SLoc, Reason) ----------
  function gdSapTotalChunks(d){
    return Math.max(1, Math.ceil(d.items.length / (d.sapChunkSize || GD_SAP_CHUNK)));
  }
  function gdSapSectionHtml(key, d){
    if(d.sapChunkSize === undefined) d.sapChunkSize = GD_SAP_CHUNK;
    if(d.sapChunkIndex === undefined) d.sapChunkIndex = 0;
    var total = gdSapTotalChunks(d);
    if(d.sapChunkIndex >= total) d.sapChunkIndex = total - 1;
    if(d.sapChunkIndex < 0) d.sapChunkIndex = 0;
    var size = d.sapChunkSize, start = d.sapChunkIndex * size;
    var chunk = d.items.slice(start, start + size);
    var safeKey = gdSafe(key);
    var copiedMap = d.sapCopied || {};
    var thisCopied = !!copiedMap[d.sapChunkIndex];
    var copiedCount = Object.keys(copiedMap).length;

    var rowsHtml = chunk.map(function(it){
      var sap = gdSapReason(it.reason);
      return '<tr><td>' + escapeHtml(it.material) + '</td><td>' + escapeHtml(String(it.qty)) + '</td><td>' + escapeHtml(it.salesUnit || '') + '</td>' +
        '<td>' + escapeHtml(currentOutletPlant) + '</td><td>1000</td>' +
        '<td>' + (sap ? escapeHtml(sap) : '<span class="sap-reason-note">blank</span>') + ' <span class="sap-reason-note">' + escapeHtml(it.reason) + '</span></td></tr>';
    }).join('');

    return '<hr class="divider">' +
      '<h2><span class="step-badge">&#128203;</span> Copy to SAP</h2>' +
      '<div class="pending-meta" style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">' +
        '<span>Batch ' + (d.sapChunkIndex + 1) + ' of ' + total + ' &middot; ' + chunk.length + ' row' + (chunk.length === 1 ? '' : 's') +
        (thisCopied ? ' &middot; <b style="color:#2f7d4f;">&#10003; Copied</b>' : '') + ' &middot; ' + copiedCount + '/' + total + ' copied</span>' +
        '<span style="display:flex;align-items:center;gap:6px;"><label style="margin:0;text-transform:none;font-size:12.5px;">Rows per batch</label>' +
        '<input type="number" min="1" max="50" step="1" value="' + size + '" style="width:60px;padding:5px 8px;" onchange="gdSetSapChunk(\'' + key + '\', this.value)"></span>' +
      '</div>' +
      '<table><thead><tr><th>Material</th><th>Qty</th><th>UOM</th><th>Plant</th><th>SLoc</th><th>Reason</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      '<div class="btn-row">' +
        '<button class="btn ghost" ' + (d.sapChunkIndex <= 0 ? 'disabled' : '') + ' onclick="gdSapPrev(\'' + key + '\')">Prev</button>' +
        '<button class="btn secondary"' + (gdUomLocked(d) ? ' disabled' : '') + ' onclick="gdCopySap(\'' + key + '\')">' + (thisCopied ? 'Copy Again' : 'Copy Batch') + '</button>' +
        '<button class="btn ghost" ' + (d.sapChunkIndex >= total - 1 ? 'disabled' : '') + ' onclick="gdSapNext(\'' + key + '\')">Next</button>' +
      '</div>' +
      '<div id="gdSapStatus_' + safeKey + '">' + (d.sapNotice ? gdOkHtml(d.sapNotice) : '') + '</div>';
  }
  function gdSetSapChunk(key, value){
    var d = gdDraft[key]; var n = parseInt(value, 10);
    if(!n || n < 1) n = 1;
    d.sapChunkSize = n; d.sapChunkIndex = 0; d.sapCopied = {}; d.sapNotice = '';
    gdRenderPendingFiltered();
  }
  function gdSapPrev(key){ var d = gdDraft[key]; d.sapChunkIndex = Math.max(0, (d.sapChunkIndex || 0) - 1); d.sapNotice = ''; gdRenderPendingFiltered(); }
  function gdSapNext(key){ var d = gdDraft[key]; d.sapChunkIndex = Math.min(gdSapTotalChunks(d) - 1, (d.sapChunkIndex || 0) + 1); d.sapNotice = ''; gdRenderPendingFiltered(); }
  function gdCopySap(key){
    var d = gdDraft[key];
    if(gdUomLocked(d)) return;
    var size = d.sapChunkSize || GD_SAP_CHUNK;
    var chunk = d.items.slice((d.sapChunkIndex || 0) * size, (d.sapChunkIndex || 0) * size + size);
    var st = document.getElementById('gdSapStatus_' + gdSafe(key));
    var tsv = chunk.map(function(it){
      return [it.material, it.qty, it.salesUnit || '', currentOutletPlant, '1000', gdSapReason(it.reason)].join('\t');
    }).join('\n');
    navigator.clipboard.writeText(tsv).then(function(){
      if(!d.sapCopied) d.sapCopied = {};
      var idx = d.sapChunkIndex || 0;
      d.sapCopied[idx] = true;
      var total = gdSapTotalChunks(d);
      d.sapNotice = 'Copied batch ' + (idx + 1) + ' of ' + total + ' (' + chunk.length + ' row' + (chunk.length === 1 ? '' : 's') + ').';
      if(idx < total - 1){ d.sapChunkIndex = idx + 1; d.sapNotice += ' Moved to batch ' + (idx + 2) + '.'; }
      else d.sapNotice += ' That was the last batch.';
      gdRenderPendingFiltered();
    }).catch(function(err){
      st.innerHTML = gdErrHtml('Copy failed: ' + err.message);
    });
  }

  // ---------- Print Here (only option - no Print Station) ----------
  function gdPrintBatch(key){
    var d = gdDraft[key];
    if(!d) return;
    if(d.submitted){ gdOpenPrint(d.submitted); return; }
    var batch = gdFindBatch(key);
    if(!batch) return;
    gdOpenPrint(gdPrintData(batch, d.materialDocument, d.keyInBy, d.items));
  }

  function gdOpenPrint(p){
    var rows = p.items.map(function(it, idx){
      return '<tr><td class="no">' + (idx + 1) + '</td><td>' + escapeHtml(it.material) + '</td><td>' + escapeHtml(it.ean) + '</td><td>' + escapeHtml(it.description) + '</td>' +
        '<td>' + escapeHtml(String(it.qty)) + '</td><td>' + escapeHtml(it.salesUnit) + '</td><td>' + escapeHtml(it.reason) + '</td></tr>';
    }).join('');
    var outletName = outletShortName(currentOutletPlant);
    var html =
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + escapeHtml(outletName) + ' Goods Disposal</title><style>' +
      'body{font-family:Georgia,"Times New Roman",serif;color:#222;margin:32px;}' +
      '.title{text-align:center;font-size:20px;font-weight:700;letter-spacing:0.5px;margin-bottom:2px;}' +
      '.subtitle{text-align:center;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;}' +
      '.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;font-size:13px;margin-bottom:14px;border-top:1px solid #999;border-bottom:1px solid #999;padding:10px 0;}' +
      '.meta .col > div{margin-bottom:8px;}.meta .col > div:last-child{margin-bottom:0;}' +
      '.meta div span{color:#666;}.meta div b{display:block;font-size:14px;}.meta div b.blank{height:20px;width:170px;border-bottom:1px solid #333;margin-top:2px;}' +
      'table{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:30px;}' +
      'thead{display:table-header-group;}tr{page-break-inside:avoid;}' +
      '.doc-head-cell{border:none;padding:0 0 14px 0;text-align:left;}' +
      'th,td{border:1px solid #999;padding:7px 8px;text-align:left;}' +
      'th.no,td.no{width:34px;text-align:center;padding-left:4px;padding-right:4px;}' +
      'th.col-head{background:#eee;text-transform:uppercase;font-size:11px;letter-spacing:0.3px;}' +
      '.sign-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin-top:50px;page-break-inside:avoid;}' +
      '.sign-box{font-size:12px;}.sign-line{border-top:1px solid #333;margin-top:40px;padding-top:6px;}' +
      '.sign-label{font-weight:700;text-transform:uppercase;font-size:10.5px;letter-spacing:0.4px;color:#444;}' +
      '@media print{body{margin:12mm;}}' +
      '</style></head><body><table><thead>' +
        '<tr><th colspan="7" class="doc-head-cell">' +
          '<div class="title">' + escapeHtml(outletName) + ' &mdash; Goods Disposal</div>' +
          '<div class="subtitle">Bad Stock Goods Report</div>' +
          '<div class="meta">' +
            '<div class="col">' +
              (p.refNo ? '<div><span>Reference Number</span><b>' + escapeHtml(p.refNo) + '</b></div>' : '') +
              '<div><span>Date</span><b>' + escapeHtml(p.date) + '</b></div>' +
              '<div><span>Bad Stock Category</span><b>' + escapeHtml(p.category) + '</b></div>' +
              '<div><span>Material Document</span>' + printVal(p.materialDocument) + '</div>' +
            '</div>' +
            '<div class="col">' +
              '<div><span>Staff</span><b>' + escapeHtml(p.staff) + '</b></div>' +
              '<div><span>Supervisor</span><b>' + escapeHtml(p.supervisor) + '</b></div>' +
              '<div><span>Key In By</span>' + printVal(p.keyInBy) + '</div>' +
            '</div>' +
          '</div></th></tr>' +
        '<tr><th class="col-head no">No.</th><th class="col-head">Material</th><th class="col-head">Product Code</th><th class="col-head">Description</th><th class="col-head">Qty</th><th class="col-head">Unit</th><th class="col-head">Reason</th></tr>' +
      '</thead><tbody>' + rows + '</tbody></table>' +
      '<div class="sign-grid">' +
        '<div class="sign-box"><div class="sign-line"></div><div class="sign-label">Staff</div>' + escapeHtml(p.staff) + '</div>' +
        '<div class="sign-box"><div class="sign-line"></div><div class="sign-label">Supervisor</div>' + escapeHtml(p.supervisor) + '</div>' +
        '<div class="sign-box"><div class="sign-line"></div><div class="sign-label">Verified By</div>&nbsp;</div>' +
      '</div></body></html>';

    var old = document.getElementById('printFrame');
    if(old) old.parentNode.removeChild(old);
    var frame = document.createElement('iframe');
    frame.id = 'printFrame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);
    var fdoc = frame.contentWindow.document;
    fdoc.open(); fdoc.write(html); fdoc.close();
    setTimeout(function(){
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch(e){ alert('Could not open the print dialog: ' + e.message); }
    }, 300);
  }

  // ---------- Admin: Goods ----------
  function gdAdminInit(){
    gdLoadAdminPending();
  }

  function gdAdminAddCategory(){
    var name = document.getElementById('gdNewCategoryInput').value.trim();
    var st = document.getElementById('gdNewCategoryStatus');
    if(!name){ st.innerHTML = gdErrHtml('Enter a category name.'); return; }
    if(gdCategories.some(function(c){ return c.toLowerCase() === name.toLowerCase(); })){ st.innerHTML = gdErrHtml('This category already exists.'); return; }
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Saving...</div>';
    sb.from('goods_categories').insert([{ name: name }]).then(function(res){
      if(res.error) throw new Error(res.error.message);
      return gdGetCategories();
    }).then(function(c){
      gdCategories = c;
      gdPopulateCategorySelect();
      gdRenderCategoryPicker();
      document.getElementById('gdNewCategoryInput').value = '';
      st.innerHTML = gdOkHtml('Category added.');
    }).catch(function(err){ st.innerHTML = gdErrHtml('Error: ' + err.message); });
  }

  var GD_DUP_FIELDS = [['Product Code', 'ean'], ['Material', 'material'], ['Description', 'description'], ['Sales Unit', 'sales_unit'], ['Numerator', 'numerator'], ['Department', 'department']];
  var gdDupPending = null; // { rec, id }

  function gdAdminSaveItem(){
    var btn = document.getElementById('gdAdmSaveBtn');
    if(btn.disabled) return; // already saving, or waiting on the overwrite confirmation
    var st = document.getElementById('gdAdmSaveStatus');
    var panel = document.getElementById('gdAdmDupPanel');
    var rec = {
      material: document.getElementById('gdAdmMaterial').value.trim(),
      description: document.getElementById('gdAdmDesc').value.trim(),
      sales_unit: document.getElementById('gdAdmUnit').value.trim(),
      numerator: document.getElementById('gdAdmNum').value.trim(),
      ean: document.getElementById('gdAdmEan').value.trim(),
      department: document.getElementById('gdAdmDept').value.trim()
    };
    var gdMissing = missingFieldNames([['Material', rec.material], ['Material Description', rec.description], ['Sales Unit', rec.sales_unit],
      ['Numerator', rec.numerator], ['Product Code', rec.ean], ['Department', rec.department]]);
    if(gdMissing.length){ st.innerHTML = gdErrHtml('Please fill in every field. Missing: ' + gdMissing.join(', ') + '.'); return; }
    rec.numerator = Number(rec.numerator);
    if(!isFinite(rec.numerator) || rec.numerator <= 0){ st.innerHTML = gdErrHtml('Numerator must be a number greater than 0.'); return; }

    panel.innerHTML = '';
    gdDupPending = null;
    setSaveState('gdAdmSaveBtn', 'busy');
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Checking...</div>';

    // One row per Product Code: look for an existing row before writing anything.
    sb.from('goods_masterlist').select('id, ean, material, description, sales_unit, numerator, department').eq('ean', rec.ean).limit(1).then(function(res){
      if(res.error) throw new Error(res.error.message);
      var ex = res.data && res.data[0];
      if(!ex) return gdSaveItemNow(rec, null);
      if(dupSame(ex, rec, ['material', 'description', 'sales_unit', 'numerator', 'department'])){
        st.innerHTML = gdOkHtml('Product Code ' + rec.ean + ' is already in the Goods masterlist with the same details. Nothing was saved.');
        setSaveState('gdAdmSaveBtn', 'idle');
        return;
      }
      gdDupPending = { rec: rec, id: ex.id };
      st.innerHTML = '';
      panel.innerHTML =
        '<div style="border:1px solid var(--danger);border-radius:12px;padding:12px;margin-top:12px;">' +
          '<b>Product Code ' + escapeHtml(rec.ean) + ' already exists in the Goods masterlist.</b>' +
          '<div class="pending-meta" style="margin-top:4px;">Nothing has been saved. Overwriting replaces the existing item\'s details with yours.</div>' +
          dupCompareHtml(GD_DUP_FIELDS, ex, rec) +
          '<button class="btn danger btn-full" id="gdAdmDupConfirm" onclick="gdConfirmOverwrite()">Overwrite existing item</button>' +
          '<button class="btn ghost btn-full" onclick="gdCancelOverwrite()">Cancel (add nothing)</button>' +
        '</div>';
      setSaveState('gdAdmSaveBtn', 'locked');
    }).catch(function(err){
      st.innerHTML = gdErrHtml('Error: ' + err.message);
      setSaveState('gdAdmSaveBtn', 'idle');
    });
  }

  function gdConfirmOverwrite(){
    var c = document.getElementById('gdAdmDupConfirm');
    if(!gdDupPending || (c && c.disabled)) return;
    if(c) c.disabled = true;
    setSaveState('gdAdmSaveBtn', 'busy');
    gdSaveItemNow(gdDupPending.rec, gdDupPending.id).catch(function(){});
  }

  function gdCancelOverwrite(){
    gdDupPending = null;
    document.getElementById('gdAdmDupPanel').innerHTML = '';
    document.getElementById('gdAdmSaveStatus').innerHTML = gdOkHtml('Cancelled. Nothing was saved.');
    setSaveState('gdAdmSaveBtn', 'idle');
  }

  function gdSaveItemNow(rec, existingId){
    var st = document.getElementById('gdAdmSaveStatus');
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Saving...</div>';
    var op = existingId
      ? sb.from('goods_masterlist').update(rec).eq('id', existingId)
      : sb.from('goods_masterlist').insert([Object.assign({}, rec, { added_plant: currentOutletPlant })]);
    return op.then(function(r){
      if(r.error) throw new Error(r.error.message);
      gdDupPending = null;
      document.getElementById('gdAdmDupPanel').innerHTML = '';
      st.innerHTML = gdOkHtml(existingId ? 'Existing barcode updated.' : 'New barcode added.');
      loadRecentMasterActivity();
      ['gdAdmMaterial', 'gdAdmDesc', 'gdAdmUnit', 'gdAdmNum', 'gdAdmEan', 'gdAdmDept'].forEach(function(id){ document.getElementById(id).value = ''; });
      setSaveState('gdAdmSaveBtn', 'idle');
    }).catch(function(err){
      st.innerHTML = gdErrHtml('Error: ' + err.message);
      setSaveState('gdAdmSaveBtn', gdDupPending ? 'locked' : 'idle');
      var c = document.getElementById('gdAdmDupConfirm'); if(c) c.disabled = false;
      throw err;
    });
  }

  var gdAdmFound = [];
  function gdAdminSearch(){
    var code = document.getElementById('gdAdmSearchInput').value.trim();
    var st = document.getElementById('gdAdmSearchStatus');
    var out = document.getElementById('gdAdmSearchResult');
    out.innerHTML = '';
    if(!code){ st.innerHTML = gdErrHtml('Enter a barcode or material.'); return; }
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Searching...</div>';
    gdLookup(code).then(function(rows){
      gdAdmFound = rows;
      if(!rows.length){ st.innerHTML = gdErrHtml('Not found in the Goods masterlist.'); return; }
      st.innerHTML = '';
      out.innerHTML = rows.map(function(r, i){
        return '<div class="card"><div class="cart-desc">' + escapeHtml(r.description || '') + '</div>' +
          '<div class="cart-sub">Material ' + escapeHtml(r.material) + ' &middot; ' + escapeHtml(r.ean || '-') + ' &middot; ' + escapeHtml(r.sales_unit || '-') +
          ' &middot; numerator ' + (r.numerator == null ? '-' : escapeHtml(String(r.numerator))) + ' &middot; ' + escapeHtml(r.department || '-') + '</div>' +
          '<button class="btn ghost btn-full" onclick="gdAdminLoadIntoForm(' + i + ')">Edit in Masterlist Update</button></div>';
      }).join('');
    }).catch(function(err){ st.innerHTML = gdErrHtml(err.message); });
  }
  function gdAdminLoadIntoForm(i){
    var r = gdAdmFound[i]; if(!r) return;
    document.getElementById('gdAdmMaterial').value = r.material || '';
    document.getElementById('gdAdmDesc').value = r.description || '';
    document.getElementById('gdAdmUnit').value = r.sales_unit || '';
    document.getElementById('gdAdmNum').value = r.numerator == null ? '' : r.numerator;
    document.getElementById('gdAdmEan').value = r.ean || '';
    document.getElementById('gdAdmDept').value = r.department || '';
    showTab('master');
    document.getElementById('gdAdmSaveStatus').innerHTML = gdOkHtml('Loaded - change what you need, then Save.');
    document.getElementById('gdAdmMaterial').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function gdLoadAdminPending(){
    document.getElementById('gdAdminPendingList').innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
    document.getElementById('gdAdminPendingEmpty').style.display = 'none';
    return gdGetPendingFromSupabase().then(function(entries){
      gdAdminPending = entries;
      gdRenderAdminPending();
    }).catch(function(err){
      document.getElementById('gdAdminPendingList').innerHTML = gdErrHtml('Failed to load pending goods transactions: ' + err.message);
    });
  }
  function gdRenderAdminPending(){
    var c = document.getElementById('gdAdminPendingList');
    c.innerHTML = '';
    if(!gdAdminPending.length){ document.getElementById('gdAdminPendingEmpty').style.display = 'block'; return; }
    document.getElementById('gdAdminPendingEmpty').style.display = 'none';
    gdAdminPending.forEach(function(b){
      var list = b.items.map(function(it){ return escapeHtml(it.description || it.material) + ' &times; ' + escapeHtml(String(it.qty)) + ' ' + escapeHtml(it.salesUnit) + ' (' + escapeHtml(it.reason) + ')'; }).join(', ');
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="pending-card-header"><div><span class="cat-tag">' + escapeHtml(b.category) + '</span></div><div class="pending-meta">' + escapeHtml(b.dateDisplay) + '</div></div>' +
        '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(b.staff) + '</b> &middot; ' + escapeHtml(b.supervisor) + '</div>' +
        '<div class="pending-meta" style="margin-top:8px;">' + list + '</div>' +
        '<button class="btn danger btn-full" onclick="gdDeleteAdminBatch(\'' + b.txnId + '\')">Delete Transaction</button>' +
        '<div id="gdAdminDelStatus_' + gdSafe(b.txnId) + '"></div>';
      c.appendChild(card);
    });
  }
  function gdDeleteAdminBatch(key){
    var b = gdAdminPending.find(function(x){ return x.txnId === key; });
    if(!b) return;
    if(!confirm('Delete this pending goods transaction?\n\n' + (b.refNo ? 'Ref ' + b.refNo + '\n' : '') + b.category + ' · ' + b.dateDisplay + '\n' + b.staff + ' / ' + b.supervisor +
        (b.refNo ? '\n\nIt will be removed from Pending and kept in Admin > Deleted Disposal Record.'
                 : '\n\nThis permanently removes it from Supabase and cannot be undone.'))) return;
    var st = document.getElementById('gdAdminDelStatus_' + gdSafe(key));
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Deleting...</div>';
    var gdQ = b.refNo
      ? sb.from('bad_stock_goods').update({ status: 'deleted', deleted_at: new Date().toISOString() }).eq('batch_id', key).eq('status', 'pending')
      : sb.from('bad_stock_goods').delete().eq('batch_id', key);
    gdQ.then(function(res){
      if(res.error) throw new Error(res.error.message);
      gdAdminPending = gdAdminPending.filter(function(x){ return x.txnId !== key; });
      gdPending = gdPending.filter(function(x){ return x.txnId !== key; });
      delete gdDraft[key];
      gdLastPendingSig = null;
      gdRenderAdminPending();
      refreshHomeDashboard();
    }).catch(function(err){ st.innerHTML = gdErrHtml('Error: ' + err.message); });
  }

  // =====================================================================
  // ================= DOCUMENTS (both disposal types) ===================
  // =====================================================================
  function docsGroup(rows, type){
    var by = {}, order = [];
    rows.forEach(function(r){
      if(!by[r.batch_id]){
        by[r.batch_id] = { type: type, category: r.category, staff: r.staff, supervisor: r.supervisor,
          dateDisplay: formatDateDisplay(r.entry_date), doc: r.material_document, keyInBy: r.key_in_by,
          keyInDate: r.key_in_date, items: 0, qty: 0 };
        order.push(r.batch_id);
      }
      by[r.batch_id].items++; by[r.batch_id].qty += Number(r.quantity) || 0;
    });
    return order.map(function(k){ return by[k]; });
  }
  function docsCards(list){
    if(!list.length) return '<div class="empty">Nothing found.</div>';
    return list.map(function(b){
      return '<div class="card" style="margin-bottom:12px;">' +
        '<div class="pending-card-header"><div><span class="type-tag ' + (b.type === 'fm' ? 'fm' : 'gd') + '">' + (b.type === 'fm' ? 'Fresh Market' : 'Goods') + '</span>' +
        '<span class="cat-tag">' + escapeHtml(b.category || '-') + '</span></div>' +
        '<div class="pending-meta">' + escapeHtml(b.dateDisplay) + '</div></div>' +
        '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(b.staff) + '</b> &middot; ' + escapeHtml(b.supervisor) + ' &middot; ' + b.items + ' item' + (b.items === 1 ? '' : 's') + '</div>' +
        '<div class="status ok" style="margin-top:10px;">Material Document ' + escapeHtml(b.doc || '') + ' &middot; keyed in by ' + escapeHtml(b.keyInBy || '-') +
        (b.keyInDate ? ' &middot; ' + escapeHtml(formatDateDisplay(b.keyInDate)) : '') + '</div></div>';
    }).join('');
  }
  function docsQuery(builder){
    return Promise.all([
      builder(sb.from('bad_stock_fresh_market').select('*')),
      builder(sb.from('bad_stock_goods').select('*'))
    ]).then(function(rs){
      rs.forEach(function(r){ if(r.error) throw new Error(r.error.message); });
      var all = docsGroup(rs[0].data, 'fm').concat(docsGroup(rs[1].data, 'gd'));
      all.sort(function(a, b){ return String(b.keyInDate || '').localeCompare(String(a.keyInDate || '')); });
      return all;
    });
  }
  function docsSearch(){
    var doc = document.getElementById('docsSearchInput').value.trim();
    var st = document.getElementById('docsSearchStatus');
    var out = document.getElementById('docsSearchResult');
    out.innerHTML = '';
    if(!doc){ st.innerHTML = gdErrHtml('Enter a material document number.'); return; }
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Searching...</div>';
    docsQuery(function(q){ return q.eq('material_document', doc).eq('plant', currentOutletPlant); }).then(function(list){
      st.innerHTML = list.length ? '' : gdErrHtml('No transaction uses material document ' + doc + ' at ' + outletLabel(currentOutletPlant) + '.');
      out.innerHTML = list.length ? docsCards(list) : '';
    }).catch(function(err){ st.innerHTML = gdErrHtml(err.message); });
  }
  function docsLoadRecent(){
    var el = document.getElementById('docsRecent');
    docsQuery(function(q){ return q.eq('status', 'keyed_in').eq('plant', currentOutletPlant).order('key_in_date', { ascending: false }).limit(60); })
      .then(function(list){ el.innerHTML = docsCards(list.slice(0, 15)); })
      .catch(function(err){ el.innerHTML = gdErrHtml(err.message); });
  }

  // ---------- Admin page tabs ----------

  // =====================================================================
  // ======================= SUMMARY REPORT ==============================
  // =====================================================================
  // Completed (keyed_in) records of the current outlet, by entry date, grouped by
  // code and ranked by total quantity, highest first.
  var sumType = 'fm';
  var sumSel = {};          // category -> true; empty object = All categories
  var sumLast = null;       // last generated report (for printing)

  function sumPad(n){ return (n < 10 ? '0' : '') + n; }
  function sumIso(d){ return d.getFullYear() + '-' + sumPad(d.getMonth() + 1) + '-' + sumPad(d.getDate()); }
  function sumShow(iso){ var p = iso.split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }

  function sumInit(){
    var f = document.getElementById('sumFrom'), t = document.getElementById('sumTo');
    if(!t.value){
      var now = new Date();
      t.value = sumIso(now);
      f.value = sumIso(new Date(now.getFullYear(), now.getMonth(), 1));
    }
    sumRenderCats();
  }

  function sumCategoryList(){ return (sumType === 'gd' ? gdCategories : appCategories).slice(); }

  function sumSetType(t){
    sumType = t;
    sumSel = {};
    document.getElementById('sumTypeFm').classList.toggle('active', t === 'fm');
    document.getElementById('sumTypeGd').classList.toggle('active', t === 'gd');
    document.getElementById('sumResult').innerHTML = '';
    document.getElementById('sumStatus').innerHTML = '';
    sumLast = null; sumSetActions(false);
    sumRenderCats();
  }

  function sumRenderCats(){
    var box = document.getElementById('sumCats');
    var all = Object.keys(sumSel).length === 0;
    var h = '<label class="sum-chip' + (all ? ' on' : '') + '"><input type="checkbox" ' + (all ? 'checked ' : '') + 'onchange="sumToggleAll()"> All categories</label>';
    sumCategoryList().forEach(function(c, i){
      var on = !!sumSel[c];
      h += '<label class="sum-chip' + (on ? ' on' : '') + '"><input type="checkbox" data-i="' + i + '" ' + (on ? 'checked ' : '') + 'onchange="sumToggleCat(' + i + ')"> ' + escapeHtml(c) + '</label>';
    });
    box.innerHTML = h;
  }
  function sumToggleAll(){ sumSel = {}; sumRenderCats(); }
  function sumToggleCat(i){
    var c = sumCategoryList()[i];
    if(sumSel[c]) delete sumSel[c]; else sumSel[c] = true;
    sumRenderCats();   // no category ticked = back to All
  }

  // Page through results (Supabase returns at most 1000 rows per request).
  function sumFetchAll(table, cols, fromIso, toIso, cats){
    var PAGE = 1000, out = [];
    function next(offset){
      var q = sb.from(table).select(cols)
        .eq('status', 'keyed_in').eq('plant', currentOutletPlant)
        .gte('entry_date', fromIso).lt('entry_date', toIso);
      if(cats.length) q = q.in('category', cats);
      return q.order('id', { ascending: true }).range(offset, offset + PAGE - 1).then(function(res){
        if(res.error) throw new Error(res.error.message);
        out = out.concat(res.data || []);
        return (res.data && res.data.length === PAGE) ? next(offset + PAGE) : out;
      });
    }
    return next(0);
  }

  function sumRun(){
    var from = document.getElementById('sumFrom').value, to = document.getElementById('sumTo').value;
    var st = document.getElementById('sumStatus'), out = document.getElementById('sumResult');
    out.innerHTML = '';
    sumSetActions(false);
    if(!from || !to){ st.innerHTML = '<div class="status err">Choose both a From and a To date.</div>'; return; }
    if(from > to){ st.innerHTML = '<div class="status err">The From date is after the To date.</div>'; return; }
    var cats = Object.keys(sumSel);
    var fromIso = new Date(from + 'T00:00:00').toISOString();
    var end = new Date(to + 'T00:00:00'); end.setDate(end.getDate() + 1);
    var toIso = end.toISOString();
    var type = sumType;
    var btn = document.getElementById('sumRunBtn'); btn.disabled = true;
    st.innerHTML = '<div class="status ok"><span class="spinner"></span> Building report...</div>';

    var table = type === 'fm' ? 'bad_stock_fresh_market' : 'bad_stock_goods';
    var cols = type === 'fm' ? 'plu_code,material,description,uom,quantity,category,batch_id' : 'material,ean,description,sales_unit,quantity,category,batch_id';
    sumFetchAll(table, cols, fromIso, toIso, cats).then(function(rows){
      var by = {}, order = [], batches = {};
      rows.forEach(function(r){
        var key = type === 'fm' ? [r.plu_code, r.uom].join('|') : [r.material, r.ean, r.sales_unit].join('|');
        var g = by[key];
        if(!g){
          g = by[key] = type === 'fm'
            ? { code: r.plu_code, mat: r.material, desc: r.description, unit: r.uom, qty: 0, txns: {} }
            : { code: r.material, code2: r.ean, desc: r.description, unit: r.sales_unit, qty: 0, txns: {} };
          order.push(key);
        }
        g.qty += Number(r.quantity) || 0;
        g.txns[r.batch_id] = true;
        batches[r.batch_id] = true;
      });
      var list = order.map(function(k){ var g = by[k]; g.qty = Math.round(g.qty * 100) / 100; g.n = Object.keys(g.txns).length; return g; });
      list.sort(function(a, b){ return b.qty - a.qty || String(a.desc).localeCompare(String(b.desc)); });
      sumLast = { type: type, from: from, to: to, cats: cats, list: list, records: Object.keys(batches).length };
      st.innerHTML = '';
      sumRenderResult();
      sumSetActions(list.length > 0);
    }).catch(function(err){
      st.innerHTML = '<div class="status err">Error: ' + escapeHtml(err.message) + '</div>';
    }).then(function(){ btn.disabled = false; });
  }

  function sumHeadLine(r){
    return { title: (r.type === 'fm' ? 'Fresh Market' : 'Goods') + ' Disposal Summary',
      range: sumShow(r.from) + ' – ' + sumShow(r.to),
      cats: r.cats.length ? r.cats.join(', ') : 'All categories' };
  }
  function sumTableHtml(r, cls){
    var gd = r.type === 'gd';
    return '<table class="' + cls + '"><thead><tr><th class="rank">No.</th>' +
      (gd ? '<th>Material</th><th>Product Code</th>' : '<th>Material</th><th>PLU / Product Code</th>') +
      '<th>Description</th><th>UOM</th><th class="num">Total Qty</th><th class="num">Records</th></tr></thead><tbody>' +
      r.list.map(function(g, i){
        return '<tr><td class="rank">' + (i + 1) + '</td>' +
          (gd ? '<td>' + escapeHtml(g.code) + '</td><td>' + escapeHtml(g.code2 || '') + '</td>' : '<td>' + escapeHtml(g.mat || '') + '</td><td>' + escapeHtml(g.code) + '</td>') +
          '<td>' + escapeHtml(g.desc || '') + '</td><td>' + escapeHtml(g.unit || '') + '</td>' +
          '<td class="num">' + escapeHtml(String(g.qty)) + '</td><td class="num">' + g.n + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function sumRenderResult(){
    var r = sumLast, out = document.getElementById('sumResult');
    if(!r) return;
    var hd = sumHeadLine(r);
    if(!r.list.length){
      out.innerHTML = '<div class="card"><div class="sum-head"><span><b>' + escapeHtml(hd.title) + '</b></span><span>' + escapeHtml(hd.range) + '</span></div>' +
        '<div class="empty">No completed records found for this selection.</div></div>';
      return;
    }
    out.innerHTML = '<div class="card">' +
      '<div class="sum-head"><span><b>' + escapeHtml(hd.title) + '</b></span><span>' + escapeHtml(hd.range) + '</span><span>Category: <b>' + escapeHtml(hd.cats) + '</b></span>' +
      '<span><b>' + r.list.length + '</b> item' + (r.list.length === 1 ? '' : 's') + '</span><span><b>' + r.records + '</b> completed record' + (r.records === 1 ? '' : 's') + '</span></div>' +
      '<div style="overflow-x:auto;">' + sumTableHtml(r, 'sum-table') + '</div>' +
      '</div>';
  }
  function sumSetActions(on){
    document.getElementById('sumPrintBtn').disabled = !on;
    document.getElementById('sumExportBtn').disabled = !on;
  }

  function sumExport(){
    var r = sumLast; if(!r || !r.list.length) return;
    if(typeof XLSX === 'undefined'){ alert('The Excel library has not loaded yet. Check the internet connection and try again.'); return; }
    var hd = sumHeadLine(r), gd = r.type === 'gd';
    var rows = [
      [outletShortName(currentOutletPlant) + ' \u2014 ' + hd.title],
      ['Period', hd.range], ['Category', hd.cats], ['Items', r.list.length], ['Completed records', r.records], [],
      gd ? ['No.', 'Material', 'Product Code', 'Description', 'UOM', 'Total Qty', 'Records']
         : ['No.', 'Material', 'PLU / Product Code', 'Description', 'UOM', 'Total Qty', 'Records']
    ];
    r.list.forEach(function(g, i){
      rows.push(gd ? [i + 1, g.code, g.code2 || '', g.desc || '', g.unit || '', g.qty, g.n]
                   : [i + 1, g.mat || '', g.code, g.desc || '', g.unit || '', g.qty, g.n]);
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 20 }, { wch: 38 }, { wch: 8 }, { wch: 11 }, { wch: 9 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Summary');
    XLSX.writeFile(wb, 'DRS-' + (gd ? 'Goods' : 'FreshMarket') + '-Summary-' + r.from + '_to_' + r.to + '.xlsx');
  }

  function sumPrint(){
    var r = sumLast; if(!r) return;
    var hd = sumHeadLine(r), outletName = outletShortName(currentOutletPlant);
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + escapeHtml(outletName) + ' ' + escapeHtml(hd.title) + '</title><style>' +
      'body{font-family:Georgia,"Times New Roman",serif;color:#222;margin:32px;}' +
      '.title{text-align:center;font-size:20px;font-weight:700;margin-bottom:2px;}' +
      '.subtitle{text-align:center;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;}' +
      '.meta{font-size:13px;border-top:1px solid #999;border-bottom:1px solid #999;padding:8px 0;margin-bottom:14px;}' +
      'table{width:100%;border-collapse:collapse;font-size:12.5px;}thead{display:table-header-group;}tr{page-break-inside:avoid;}' +
      'th,td{border:1px solid #999;padding:6px 8px;text-align:left;}th{background:#eee;text-transform:uppercase;font-size:11px;}' +
      'td.num,th.num{text-align:right;}td.rank,th.rank{width:34px;text-align:center;}@media print{body{margin:12mm;}}' +
      '</style></head><body><div class="title">' + escapeHtml(outletName) + ' &mdash; ' + escapeHtml(hd.title) + '</div>' +
      '<div class="meta">Period: <b>' + escapeHtml(hd.range) + '</b> &nbsp;|&nbsp; Category: <b>' + escapeHtml(hd.cats) + '</b> &nbsp;|&nbsp; ' + r.list.length + ' items, ' + r.records + ' records</div>' +
      sumTableHtml(r, '') + '</body></html>';
    var old = document.getElementById('printFrame'); if(old) old.parentNode.removeChild(old);
    var frame = document.createElement('iframe');
    frame.id = 'printFrame'; frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);
    var d = frame.contentWindow.document; d.open(); d.write(html); d.close();
    setTimeout(function(){ try{ frame.contentWindow.focus(); frame.contentWindow.print(); }catch(e){ alert('Could not open the print dialog: ' + e.message); } }, 300);
  }

  // ---------- Admin: tile menu (Unpost / Fresh Market / Goods) ----------
  var ADMIN_BOXES = ['Unpost', 'Fm', 'Gd', 'Deleted'];
  function adminOpenBox(name){
    ADMIN_BOXES.forEach(function(n){
      var el = document.getElementById('adminBox' + n);
      if(el) el.style.display = (n === name) ? 'block' : 'none';
    });
    document.getElementById('adminMenu').style.display = 'none';
    if(name === 'Fm') loadAdminPendingList();
    if(name === 'Gd') gdLoadAdminPending();
    if(name === 'Deleted') delReset();
    window.scrollTo(0, 0);
  }
  function adminCloseBox(){
    ADMIN_BOXES.forEach(function(n){
      var el = document.getElementById('adminBox' + n);
      if(el) el.style.display = 'none';
    });
    document.getElementById('adminMenu').style.display = 'block';
    window.scrollTo(0, 0);
  }


  // ---------- Admin: Deleted Disposal Record ----------
  var delType = null;
  function delReset(){
    delType = null;
    document.getElementById('delTypeFm').classList.remove('active');
    document.getElementById('delTypeGd').classList.remove('active');
    document.getElementById('delList').innerHTML = '<div class="empty">Choose Fresh Market or Goods to view deleted records.</div>';
  }
  function delSetType(t){
    delType = t;
    document.getElementById('delTypeFm').classList.toggle('active', t === 'fm');
    document.getElementById('delTypeGd').classList.toggle('active', t === 'gd');
    var box = document.getElementById('delList');
    box.innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';
    var p = t === 'fm' ? getPendingEntriesFromSupabase('deleted') : gdGetPendingFromSupabase('deleted');
    p.then(function(list){
      if(delType !== t) return;
      list.sort(function(a, b){ return String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')); });
      if(!list.length){ box.innerHTML = '<div class="empty">No deleted ' + (t === 'fm' ? 'Fresh Market' : 'Goods') + ' records.</div>'; return; }
      box.innerHTML = list.map(function(b){
        var items = b.items.map(function(it){
          return t === 'fm'
            ? escapeHtml(it.description || ('PLU ' + it.plu)) + ' &times; ' + escapeHtml(String(it.qty)) + (it.uom ? ' ' + escapeHtml(it.uom) : '')
            : escapeHtml(it.description || it.material) + ' &times; ' + escapeHtml(String(it.qty)) + ' ' + escapeHtml(it.salesUnit || '');
        }).join(', ');
        return '<div class="card">' +
          '<div class="pending-card-header"><div><span class="cat-tag">' + escapeHtml(b.category) + '</span>' + refTag(b) + '</div>' +
          '<div class="pending-meta">' + escapeHtml(b.dateDisplay) + '</div></div>' +
          '<div class="pending-meta" style="margin-top:6px;"><b>' + escapeHtml(b.staff) + '</b> &middot; ' + escapeHtml(b.supervisor) + (b.checkedBy ? ' &middot; ' + escapeHtml(b.checkedBy) : '') + '</div>' +
          '<div class="pending-meta" style="margin-top:8px;">' + items + '</div>' +
          '<div class="status err" style="margin-top:10px;">Deleted' + (b.deletedAt ? ' on ' + escapeHtml(formatDateDisplay(b.deletedAt)) : '') + '</div></div>';
      }).join('');
    }).catch(function(err){
      box.innerHTML = '<div class="status err">Failed to load deleted records: ' + escapeHtml(err.message) + '</div>';
    });
  }

  function adminSwitchPane(name){
    ['Store','Master','Admin'].forEach(function(n){
      var pane = document.getElementById('adminPane' + n);
      if(pane) pane.style.display = n.toLowerCase() === name ? 'block' : 'none';
    });
    var h = document.getElementById('adminPageHeading');
    if(h) h.textContent = name === 'master' ? 'Masterlist Update' : (name === 'admin' ? 'Admin' : 'Store Assignment');
  }

  // ---------- Masterlist Update: recent activity (all outlets) ----------
  // Items added before the created_at column existed have no timestamp and are not listed.
  function loadRecentMasterActivity(){
    var el = document.getElementById('recentMasterActivity');
    if(!el) return;
    var since = '2000-01-01';
    var fm = sb.from('masterlist').select('plu_code, description, category, uom, created_at, added_plant')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(10);
    var gd = sb.from('goods_masterlist').select('ean, material, description, sales_unit, department, created_at, added_plant')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(10);
    Promise.all([fm, gd]).then(function(res){
      var err = res[0].error || res[1].error;
      if(err) throw new Error(err.message);
      var rows = [];
      (res[0].data || []).forEach(function(x){
        rows.push({ type: 'Fresh Market', code: x.plu_code, desc: x.description, sub: [x.category, x.uom ? 'UOM ' + x.uom : ''].filter(Boolean).join(' \u00B7 '), at: x.created_at, plant: x.added_plant });
      });
      (res[1].data || []).forEach(function(x){
        rows.push({ type: 'Goods', code: x.ean || x.material, desc: x.description,
          sub: [x.sales_unit ? 'UOM ' + x.sales_unit : '', x.department].filter(Boolean).join(' \u00B7 '), at: x.created_at, plant: x.added_plant });
      });
      rows.sort(function(a, b){ return a.at < b.at ? 1 : (a.at > b.at ? -1 : 0); });
      rows = rows.slice(0, 10);
      if(!rows.length){ el.innerHTML = '<div class="empty">No new items added yet.</div>'; return; }
      el.innerHTML = rows.map(function(x){
        return '<div style="padding:10px 0;border-top:1px solid var(--border);">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
            '<span class="cat-tag">' + escapeHtml(x.type) + '</span>' +
            '<span class="pending-meta">' + escapeHtml(formatDateDisplay(x.at)) + '</span>' +
          '</div>' +
          '<div style="font-weight:700;margin-top:6px;">' + escapeHtml(x.desc || '-') + '</div>' +
          '<div class="pending-meta" style="margin-top:2px;">' + escapeHtml(String(x.code || '-')) + (x.sub ? ' &middot; ' + escapeHtml(x.sub) : '') +
            ' &middot; Added at ' + escapeHtml(x.plant ? outletLabel(x.plant) : '-') + '</div>' +
        '</div>';
      }).join('');
    }).catch(function(err){
      el.innerHTML = '<div class="status err">Could not load recent activity: ' + escapeHtml(err.message) + '</div>';
    });
  }

  // ---------- Masterlist duplicate check + save-button lock (shared) ----------
  // Names of the fields that are still empty, e.g. [['PLU', plu], ['UOM', uom]] -> 'UOM'
  function missingFieldNames(pairs){
    return pairs.filter(function(p){ return !String(p[1] == null ? '' : p[1]).trim(); }).map(function(p){ return p[0]; });
  }

  function dupNorm(v){ return v == null ? '' : String(v).trim(); }

  function dupSame(existing, incoming, keys){
    return keys.every(function(k){ return dupNorm(existing[k]) === dupNorm(incoming[k]); });
  }

  // Side-by-side Existing / New table. Rows that differ are highlighted.
  function dupCompareHtml(fields, existing, incoming){
    return '<table style="margin:10px 0;"><thead><tr><th></th><th>Existing item</th><th>Your entry</th></tr></thead><tbody>' +
      fields.map(function(f){
        var differs = dupNorm(existing[f[1]]) !== dupNorm(incoming[f[1]]);
        return '<tr' + (differs ? ' style="background:var(--danger-soft);"' : '') + '>' +
          '<td><b>' + escapeHtml(f[0]) + '</b></td>' +
          '<td>' + escapeHtml(dupNorm(existing[f[1]]) || '\u2014') + '</td>' +
          '<td>' + escapeHtml(dupNorm(incoming[f[1]]) || '\u2014') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // state: 'busy' (Saving...), 'locked' (disabled, e.g. while a confirm panel is open), 'idle'
  function setSaveState(btnId, state){
    var b = document.getElementById(btnId);
    if(!b) return;
    if(b.dataset.label === undefined) b.dataset.label = b.textContent;
    b.disabled = state !== 'idle';
    b.textContent = state === 'busy' ? 'Saving...' : b.dataset.label;
  }

  // ---------- Disposal Records: edit mode (Fresh Market + Goods) ----------
  // A pending entry is read-only until Edit is tapped. Edit takes a snapshot so
  // Cancel can restore it, and leaving the entry (switching category, sub-tab,
  // Fresh Market/Goods or any page) is blocked while there are unsaved changes.
  var editMode = {}; // txnId -> { type: 'fm' | 'gd', snapshot: { items, removedIds, sig } }

  function editDraftOf(type, key){ return type === 'gd' ? gdDraft[key] : pendingDraft[key]; }

  function editSig(type, d){
    if(type === 'gd'){
      return JSON.stringify([d.items.map(function(i){ return [i.id || ('n:' + i.material + i.ean + i.reason), i.qty]; }), (d.removedIds || []).slice().sort()]);
    }
    return JSON.stringify(d.items.map(function(i){ return [i.plu, i.qty, i.description, i.isNew ? 1 : 0]; }));
  }

  function editRerender(type){
    if(type === 'gd') gdRenderPendingFiltered(); else renderPendingListFiltered();
  }

  function startEdit(type, key){
    var d = editDraftOf(type, key);
    if(!d || d.submitted) return;
    editMode[key] = {
      type: type,
      snapshot: { items: JSON.parse(JSON.stringify(d.items)), removedIds: (d.removedIds || []).slice(), sig: editSig(type, d) }
    };
    if(type === 'gd') gdCollapsed[key] = false; else pendingCollapsedState[key] = false; // open the card
    editRerender(type);
  }

  function cancelEdit(type, key){
    var e = editMode[key], d = editDraftOf(type, key);
    if(e && d){
      d.items = e.snapshot.items;
      if(type === 'gd') d.removedIds = e.snapshot.removedIds;
      d.pluInput = ''; d.qtyInput = ''; d.pendingAddDescription = '';
    }
    delete editMode[key];
    editRerender(type);
  }

  function editIsDirty(key){
    var e = editMode[key], d = e && editDraftOf(e.type, key);
    return !!(d && !d.submitted && editSig(e.type, d) !== e.snapshot.sig);
  }

  // Returns true (and tells the person why) when an entry has unsaved edits.
  // An entry opened with Edit but left unchanged just leaves edit mode quietly.
  function editingBlocked(){
    var blockedKey = null, cleaned = false;
    Object.keys(editMode).forEach(function(k){
      var e = editMode[k], d = editDraftOf(e.type, k);
      if(!d || d.submitted){ delete editMode[k]; return; }
      if(editIsDirty(k)){ if(!blockedKey) blockedKey = k; }
      else { delete editMode[k]; cleaned = true; }
    });
    if(cleaned){ renderPendingListFiltered(); gdRenderPendingFiltered(); }
    if(!blockedKey) return false;
    var e = editMode[blockedKey];
    var batch = e.type === 'gd'
      ? gdFindBatch(blockedKey)
      : fmFindBatch(blockedKey);
    alert('You have not saved the edited entry yet' + (batch ? ' (' + batch.category + ' \u00B7 ' + batch.staff + ')' : '') + '.\n\n' +
      'Tap "Save Changes" to keep your edits, or "Cancel" to discard them, before you switch.');
    var el = document.getElementById('pcard_' + blockedKey.replace(/[^a-zA-Z0-9]/g, '_'));
    if(el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  window.addEventListener('beforeunload', function(ev){
    if(Object.keys(editMode).some(editIsDirty)){ ev.preventDefault(); ev.returnValue = ''; return ''; }
  });

  // ================= SHARED =================

  function escapeHtml(str){
    if(str === null || str === undefined) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
